import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { randomUUID } from "crypto";

const app = express();
app.use(express.json());
app.use(express.static("public"));

const {
  PORT = "3000",
  SERVER_PASSWORD,
  SERVER_RUNWAY_KEY,
  SERVER_RUNWAY_BASE_URL = "https://api.dev.runwayml.com",
  SERVER_RECALL_KEY,
  SERVER_RECALL_REGION = "us-west-2",
  SERVER_DAILY_KEY,
  SERVER_DAILY_DOMAIN,
  // Legacy support: RECALL_API_KEY still works if SERVER_RECALL_KEY is not set
  RECALL_API_KEY,
  RECALL_REGION,
} = process.env;

const PUBLIC_URL =
  process.env.PUBLIC_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : process.env.FLY_APP_NAME
      ? `https://${process.env.FLY_APP_NAME}.fly.dev`
      : `http://localhost:${PORT}`);

const WS_PUBLIC_URL = PUBLIC_URL.replace(/^https:\/\//, "wss://").replace(
  /^http:\/\//,
  "ws://"
);

// Recall base URL is computed per-request now (supports client-side keys)
function getRecallBase(region) {
  return `https://${region}.recall.ai/api/v1`;
}

// In-memory session store
const sessions = new Map();
// WebSocket clients: sessionId → Set of bot page WebSocket connections
const videoRelayClients = new Map();
// Server-side auth tokens (simple in-memory set)
const validTokens = new Set();

// ---------------------------------------------------------------------------
// Runway API helpers (per-user credentials)
// ---------------------------------------------------------------------------

async function runwayFetch(
  baseUrl,
  apiKey,
  path,
  { method = "GET", body, bearerToken } = {}
) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${bearerToken || apiKey}`,
      "X-Runway-Version": "2024-11-06",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (method === "DELETE" && res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      `Runway ${method} ${path} → ${res.status}: ${JSON.stringify(data)}`
    );
  }
  return data;
}

// ---------------------------------------------------------------------------
// Recall.ai API helpers (shared server credential)
// ---------------------------------------------------------------------------

async function recallFetch(recallCreds, path, { method = "GET", body } = {}) {
  const base = getRecallBase(recallCreds.region);
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Token ${recallCreds.apiKey}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      `Recall ${method} ${path} → ${res.status}: ${JSON.stringify(data)}`
    );
  }
  return data;
}

function getRecallCreds(req) {
  // Server-side auth: use server env vars
  if (isServerAuth(req)) {
    const key = SERVER_RECALL_KEY || RECALL_API_KEY;
    if (!key) throw new Error("Recall API key not configured on server");
    return { apiKey: key, region: SERVER_RECALL_REGION || RECALL_REGION || "us-west-2" };
  }
  // Client-side: from headers
  const apiKey = req.headers["x-recall-key"];
  const region = req.headers["x-recall-region"] || "us-west-2";
  if (!apiKey) throw new Error("Recall API key is required");
  return { apiKey, region };
}

async function createRecallBot(recallCreds, meetingUrl, botName, botPageUrl, sessionId) {
  const displayName = botName || "ClubAI Character";
  // Ensure wss:// protocol — PUBLIC_URL may not convert correctly on some platforms
  const wsUrl = PUBLIC_URL.replace(/^https?:\/\//, "wss://");
  return recallFetch(recallCreds, "/bot/", {
    method: "POST",
    body: {
      meeting_url: meetingUrl,
      bot_name: displayName,
      output_media: {
        camera: {
          kind: "webpage",
          config: { url: botPageUrl },
        },
      },
      chat: {
        on_bot_join: {
          send_to: "everyone",
          message: `Hello everyone, I'm ${displayName}`,
        },
      },
      variant: {
        zoom: "web_4_core",
        google_meet: "web_4_core",
        microsoft_teams: "web_4_core",
      },
      recording_config: {
        video_mixed_layout: "gallery_view_v2",
        video_separate_png: {},
        realtime_endpoints: [
          {
            type: "websocket",
            url: `${wsUrl}/ws/recall-video/${sessionId}`,
            events: ["video_separate_png.data"],
          },
        ],
      },
    },
  });
}

async function deleteRecallBot(recallCreds, botId) {
  try {
    console.log(`[recall] Sending leave_call for bot ${botId}`);
    const result = await recallFetch(recallCreds, `/bot/${botId}/leave_call/`, { method: "POST" });
    console.log(`[recall] Bot ${botId} left the call`);
    return result;
  } catch (err) {
    console.error(`[recall] Failed to remove bot ${botId}:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Middleware: extract per-user Runway credentials from headers
// ---------------------------------------------------------------------------

function isServerAuth(req) {
  const token = req.headers["x-server-token"];
  return token && validTokens.has(token);
}

function getRunwayCreds(req) {
  // If server-side auth, use server env vars
  if (isServerAuth(req) && SERVER_RUNWAY_KEY) {
    return {
      apiKey: SERVER_RUNWAY_KEY,
      baseUrl: SERVER_RUNWAY_BASE_URL.replace(/\/+$/, ""),
    };
  }
  const apiKey = req.headers["x-runway-key"];
  const baseUrl = (
    req.headers["x-runway-base-url"] || "https://api.dev.runwayml.com"
  ).replace(/\/+$/, "");
  if (!apiKey) throw new Error("Runway API key is required");
  return { apiKey, baseUrl };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Server-side auth: validate password, return token
app.post("/api/auth", (req, res) => {
  const { password } = req.body;
  if (!SERVER_PASSWORD) {
    return res.status(501).json({ error: "Server-side auth not configured" });
  }
  if (password !== SERVER_PASSWORD) {
    return res.status(401).json({ error: "Invalid password" });
  }
  const token = randomUUID();
  validTokens.add(token);
  // Return which server-side services are available
  res.json({
    token,
    services: {
      runway: !!SERVER_RUNWAY_KEY,
      daily: !!SERVER_DAILY_KEY,
      recall: !!(SERVER_RECALL_KEY || RECALL_API_KEY),
    },
  });
});

// Check server-side config availability (no auth needed)
app.get("/api/server-info", (req, res) => {
  res.json({
    serverAuthAvailable: !!SERVER_PASSWORD,
  });
});

// API ping/verify endpoints
app.get("/api/verify/runway", async (req, res) => {
  try {
    const { apiKey, baseUrl } = getRunwayCreds(req);
    await runwayFetch(baseUrl, apiKey, "/v1/avatars?limit=1");
    res.json({ ok: true });
  } catch (err) {
    res.status(401).json({ ok: false, error: err.message });
  }
});

app.get("/api/verify/recall", async (req, res) => {
  try {
    const creds = getRecallCreds(req);
    await recallFetch(creds, "/bot/?limit=1");
    res.json({ ok: true });
  } catch (err) {
    res.status(401).json({ ok: false, error: err.message });
  }
});

app.get("/api/verify/daily", async (req, res) => {
  try {
    const apiKey = isServerAuth(req) && SERVER_DAILY_KEY
      ? SERVER_DAILY_KEY
      : req.headers["x-daily-key"];
    if (!apiKey) throw new Error("Daily.co API key required");
    const response = await fetch("https://api.daily.co/v1/rooms?limit=1", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(401).json({ ok: false, error: err.message });
  }
});

// Daily.co rooms proxy (uses server key or client key)
app.get("/api/daily/rooms", async (req, res) => {
  try {
    const apiKey = isServerAuth(req) && SERVER_DAILY_KEY
      ? SERVER_DAILY_KEY
      : req.headers["x-daily-key"];
    if (!apiKey) return res.status(400).json({ error: "Daily.co API key required" });

    const response = await fetch("https://api.daily.co/v1/rooms", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test character performance (act_two model)
app.post("/api/test/character-performance", async (req, res) => {
  try {
    const { apiKey, baseUrl } = getRunwayCreds(req);
    const body = req.body || {
      model: "act_two",
      character: {
        type: "image",
        uri: "https://runway-static-assets.s3.us-east-1.amazonaws.com/devportal/playground-examples/cp-act-two-character-input.jpeg",
      },
      reference: {
        type: "video",
        uri: "https://runway-static-assets.s3.us-east-1.amazonaws.com/devportal/playground-examples/cp-act-two-reference-input.mp4",
      },
      seed: 143092836,
      bodyControl: false,
    };
    const data = await runwayFetch(baseUrl, apiKey, "/v1/character_performance", {
      method: "POST",
      body,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/avatars", async (req, res) => {
  try {
    const { apiKey, baseUrl } = getRunwayCreds(req);
    const data = await runwayFetch(baseUrl, apiKey, "/v1/avatars");
    const ready = data.data.filter((a) => a.status === "READY");
    res.json(ready);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/avatars/:id", async (req, res) => {
  try {
    const { apiKey, baseUrl } = getRunwayCreds(req);
    const data = await runwayFetch(baseUrl, apiKey, `/v1/avatars/${req.params.id}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/start", (req, res) => {
  let runway, recall;
  try {
    runway = getRunwayCreds(req);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const { meetingUrl, avatarType, avatarId, botName, maxDuration, mode = "recall" } = req.body;

  if (mode === "recall") {
    if (!meetingUrl) return res.status(400).json({ error: "meetingUrl required" });
    try {
      recall = getRecallCreds(req);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  if (!avatarId) return res.status(400).json({ error: "avatarId required" });

  const avatar =
    avatarType === "preset"
      ? { type: "runway-preset", presetId: avatarId }
      : { type: "custom", avatarId };

  const id = randomUUID();
  const session = {
    id,
    mode,
    status: "creating",
    error: null,
    runwaySessionId: null,
    recallBotId: null,
    liveKit: null,
    meetingUrl: meetingUrl || null,
    runway,
    recall: recall || null,
    logs: [],
  };
  sessions.set(id, session);

  runSessionPipeline(session, avatar, meetingUrl, botName, maxDuration);

  res.json({ sessionId: id });
});

app.get("/api/sessions/:id", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json({
    status: session.status,
    error: session.error,
    logs: session.logs,
    runwaySessionId: session.runwaySessionId,
    recallBotId: session.recallBotId,
  });
});

app.get("/api/sessions/:id/creds", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (!session.liveKit)
    return res.status(425).json({ error: "Not ready yet" });
  res.json(session.liveKit);
});

app.post("/api/sessions/:id/mute", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });

  const { muted } = req.body;
  session.muted = !!muted;

  // Send control message to the bot page via WebSocket relay
  const clients = videoRelayClients.get(req.params.id);
  if (clients) {
    const msg = JSON.stringify({ type: "control", action: "mute", muted: session.muted });
    for (const client of clients) {
      if (client.readyState === 1) client.send(msg);
    }
  }

  res.json({ muted: session.muted });
});

// Bot page debug log endpoint
app.post("/api/sessions/:id/botlog", express.text(), (req, res) => {
  const session = sessions.get(req.params.id);
  const msg = req.body || "(empty)";
  const ts = new Date().toISOString().slice(11, 23);
  const logLine = `[${ts}] [bot-page] ${msg}`;
  console.log(`[${req.params.id.slice(0, 8)}] ${logLine}`);
  if (session) session.logs.push(logLine);
  res.json({ ok: true });
});

app.post("/api/sessions/:id/stop", async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });

  await stopSession(session);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// WebSocket server for video relay
// ---------------------------------------------------------------------------

const httpServer = createServer(app);
const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = url.pathname;

  // Route: /ws/recall-video/:sessionId  — Recall sends video frames here
  // Route: /ws/video-relay/:sessionId   — Bot page connects here to receive
  const recallMatch = pathname.match(/^\/ws\/recall-video\/([^/]+)$/);
  const relayMatch = pathname.match(/^\/ws\/video-relay\/([^/]+)$/);

  if (recallMatch || relayMatch) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      if (recallMatch) {
        handleRecallVideoConnection(ws, recallMatch[1]);
      } else {
        handleVideoRelayConnection(ws, relayMatch[1]);
      }
    });
  } else {
    socket.destroy();
  }
});

function handleRecallVideoConnection(ws, sessionId) {
  console.log(`[ws] Recall video connected for session ${sessionId.slice(0, 8)}`);

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.event !== "video_separate_png.data") return;

      const frame = msg.data?.data;
      if (!frame?.buffer) return;

      // Forward to all connected bot page clients for this session
      const relay = {
        participantId: frame.participant?.id,
        participantName: frame.participant?.name,
        type: frame.type,
        buffer: frame.buffer,
      };
      const relayStr = JSON.stringify(relay);

      const clients = videoRelayClients.get(sessionId);
      if (clients) {
        for (const client of clients) {
          if (client.readyState === 1) {
            client.send(relayStr);
          }
        }
      }
    } catch {
      // ignore malformed messages
    }
  });

  ws.on("close", () => {
    console.log(`[ws] Recall video disconnected for session ${sessionId.slice(0, 8)}`);
  });
}

function handleVideoRelayConnection(ws, sessionId) {
  console.log(`[ws] Bot page video relay connected for session ${sessionId.slice(0, 8)}`);

  if (!videoRelayClients.has(sessionId)) {
    videoRelayClients.set(sessionId, new Set());
  }
  videoRelayClients.get(sessionId).add(ws);

  ws.on("close", () => {
    const clients = videoRelayClients.get(sessionId);
    if (clients) {
      clients.delete(ws);
      if (clients.size === 0) videoRelayClients.delete(sessionId);
    }
    console.log(`[ws] Bot page video relay disconnected for session ${sessionId.slice(0, 8)}`);
  });
}

// ---------------------------------------------------------------------------
// Session pipeline
// ---------------------------------------------------------------------------

async function runSessionPipeline(
  session,
  avatar,
  meetingUrl,
  botName,
  maxDuration
) {
  const { apiKey, baseUrl } = session.runway;

  const log = (msg) => {
    const ts = new Date().toISOString().slice(11, 23);
    session.logs.push(`[${ts}] ${msg}`);
    console.log(`[${session.id.slice(0, 8)}] ${msg}`);
  };

  try {
    log("Creating Runway realtime session...");
    const created = await runwayFetch(
      baseUrl,
      apiKey,
      "/v1/realtime_sessions",
      {
        method: "POST",
        body: {
          model: "gwm1_avatars",
          avatar,
          maxDuration: maxDuration || 300,
        },
      }
    );
    session.runwaySessionId = created.id;
    log(`Runway session created: ${created.id}`);

    session.status = "polling";
    log("Waiting for avatar to be ready...");
    let sessionKey;
    for (let i = 0; i < 90; i++) {
      const s = await runwayFetch(
        baseUrl,
        apiKey,
        `/v1/realtime_sessions/${created.id}`
      );
      if (s.status === "READY") {
        sessionKey = s.sessionKey;
        break;
      }
      if (s.status === "FAILED" || s.status === "CANCELLED") {
        throw new Error(`Session ${s.status}: ${s.failure || ""}`);
      }
      await sleep(2000);
    }
    if (!sessionKey)
      throw new Error("Timed out waiting for session to be ready");
    log("Avatar is ready");

    session.status = "consuming";
    log("Getting LiveKit credentials...");
    const creds = await runwayFetch(
      baseUrl,
      apiKey,
      `/v1/realtime_sessions/${created.id}/consume`,
      { method: "POST", bearerToken: sessionKey }
    );
    session.liveKit = { url: creds.url, token: creds.token };
    log(`LiveKit room: ${creds.roomName}`);

    if (session.mode === "recall") {
      session.status = "bot_joining";
      const botPageUrl = `${PUBLIC_URL}/bot.html?session=${session.id}`;
      log(`Creating Recall bot → ${meetingUrl}`);
      const wsRelayUrl = PUBLIC_URL.replace(/^https?:\/\//, "wss://");
      log(`Video relay: ${wsRelayUrl}/ws/recall-video/${session.id}`);
      const bot = await createRecallBot(
        session.recall,
        meetingUrl,
        botName,
        botPageUrl,
        session.id
      );
      session.recallBotId = bot.id;
      log(`Recall bot created: ${bot.id}`);
      session.status = "active";
      log("Character is live in the meeting!");
    } else {
      // Direct mode (daily/vdoninja): LiveKit creds ready, client handles the rest
      session.status = "active";
      log(`LiveKit credentials ready — client will bridge to ${session.mode}`);
    }
  } catch (err) {
    session.status = "failed";
    session.error = err.message;
    log(`Error: ${err.message}`);
  }
}

async function stopSession(session) {
  const log = (msg) => {
    const ts = new Date().toISOString().slice(11, 23);
    session.logs.push(`[${ts}] ${msg}`);
    console.log(`[${session.id.slice(0, 8)}] ${msg}`);
  };

  log("Stopping session...");

  if (session.recallBotId && session.recall) {
    log("Removing Recall bot from meeting...");
    await deleteRecallBot(session.recall, session.recallBotId);
  }

  if (session.runwaySessionId && session.runway) {
    log("Cancelling Runway session...");
    try {
      await runwayFetch(
        session.runway.baseUrl,
        session.runway.apiKey,
        `/v1/realtime_sessions/${session.runwaySessionId}`,
        { method: "DELETE" }
      );
    } catch {
      // best-effort
    }
  }

  // Clean up relay clients
  videoRelayClients.delete(session.id);

  session.status = "ended";
  log("Session ended");
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

httpServer.listen(parseInt(PORT), () => {
  console.log(`\n  ClubAI Character Meet running on http://localhost:${PORT}`);
  console.log(`  PUBLIC_URL raw: "${PUBLIC_URL}"`);
  console.log(`  Public URL: ${PUBLIC_URL}`);
  console.log(`  WebSocket URL: ${WS_PUBLIC_URL}`);
  console.log(`  Recall region: ${SERVER_RECALL_REGION || RECALL_REGION || 'not set'}\n`);
});
