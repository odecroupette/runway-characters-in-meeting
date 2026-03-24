# Meet ClubAI Character

Send an AI character to any video meeting as a live participant. The character
sees, hears, and responds in real time using Runway's GWM-1 Avatars.

Demo: https://charactermeetclubai.fly.dev/

## Meeting Modes

| Mode | Platform | How It Works |
|---|---|---|
| **External** | Google Meet, Zoom, Teams | A Recall.ai bot joins the meeting as a participant, rendering the character as a webpage-based camera feed. Audio is relayed through LiveKit. |
| **Daily.co** | Daily.co hosted rooms | A browser-side bridge joins the Daily.co room and Runway's LiveKit room simultaneously, piping video/audio between them. No bot infrastructure needed. |
| **VDO.Ninja** | Peer-to-peer WebRTC | The VDO.Ninja SDK publishes the character's video/audio tracks directly into the room. Serverless, free, no accounts required. |

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- A [Runway API key](https://app.runwayml.com/settings/api-keys)
- For External mode: a [Recall.ai API key](https://www.recall.ai/)
- For Daily.co mode: a [Daily.co API key](https://dashboard.daily.co/)
- For VDO.Ninja mode: nothing — it's free and open

## Quick Start

```sh
npm install
cp .env.example .env
# Edit .env — add your API keys
npm run dev
```

Open http://localhost:3000, configure API keys in Settings, pick a meeting
mode, choose a character, and go.

## API Key Configuration

Keys can be provided in two ways:

- **Client-side (browser)**: Each user enters their own keys in the Settings
  modal. Keys are stored in localStorage and never sent to the server except
  to proxy API calls.
- **Server-side**: Set keys as environment variables and protect them with
  `SERVER_PASSWORD`. Users unlock server keys from the browser without seeing
  the actual values.

## Environment Variables

| Variable | Purpose |
|---|---|
| `PORT` | Server port (default: 3000) |
| `PUBLIC_URL` | How Recall reaches this server (auto-detected on Railway/Fly.io) |
| `SERVER_PASSWORD` | Password to unlock server-side API keys from the browser |
| `SERVER_RUNWAY_KEY` | Runway API key (server-side) |
| `SERVER_RUNWAY_BASE_URL` | Runway base URL (default: https://api.dev.runwayml.com) |
| `SERVER_RECALL_KEY` | Recall.ai API key (server-side) |
| `SERVER_RECALL_REGION` | Recall.ai region (default: us-west-2) |
| `SERVER_DAILY_KEY` | Daily.co API key (server-side) |

## Deploy to Fly.io

```sh
fly launch --no-deploy
fly secrets set SERVER_PASSWORD=... SERVER_RUNWAY_KEY=... SERVER_RECALL_KEY=...
fly deploy
```

## Deploy to Railway

Push to GitHub, create a new Railway project from the repo, set environment
variables in the dashboard. `PUBLIC_URL` and `PORT` are auto-detected.

## Architecture

```
Meeting participants ←→ [Recall bot / Daily.co / VDO.Ninja]
                              ↕
                        Browser bridge (or bot.html)
                              ↕
                        LiveKit room (Runway)
                              ↕
                        Runway avatar engine (GWM-1)
```

The server (`server.js`) orchestrates Runway session creation and provides
API proxies. For External mode, a Recall.ai bot renders `bot.html` as its
camera. For Daily.co and VDO.Ninja, the browser handles the bridge directly.

## Cost

- **Runway**: Realtime session pricing (billed to API key owner)
- **Recall.ai**: ~$0.60/hour per bot (External mode only)
- **Daily.co**: Per their pricing (room hosting)
- **VDO.Ninja**: Free
