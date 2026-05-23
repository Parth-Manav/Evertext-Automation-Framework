# Hybrid Terminal Automation Framework

Hybrid Terminal Automation Framework is a multi-process automation system for authenticated, text-terminal style web workflows. It combines a Node.js orchestrator, Puppeteer browser session bootstrap, a raw Engine.IO/WebSocket client, a Rust decision engine, JSON-over-stdin/stdout IPC, encrypted local persistence, Docker deployment, and Discord slash-command operations.

The project is designed to demonstrate automation engineering, process orchestration, state-machine design, WebSocket protocol handling, reliability controls, and responsible handling of local credentials. Target-specific URLs are configurable through environment variables instead of being hardcoded in source.

## Demo

GitHub attachment:

[Evertext automation demo](https://github.com/user-attachments/assets/9e6ae87b-62be-4f77-826a-9ac8bb99c513)

## Overview

The framework handles workflows where a browser session is needed to establish or preserve authentication, but real-time terminal I/O is more efficient over WebSocket than through DOM polling. Node.js owns the I/O-heavy orchestration layer, while Rust owns deterministic terminal parsing and state transitions.

Primary capabilities:

- Browser session bootstrap with Puppeteer and cookie injection.
- Raw Engine.IO v4 / Socket.IO-style WebSocket connection using `ws`.
- Rust state machine connected to Node.js through newline-delimited JSON IPC.
- Sequential queue processing with retry, defer, and kill-switch behavior.
- AES-encrypted local storage for sensitive session data.
- Discord.js slash-command interface for operator control.
- Health endpoint for containers and uptime monitors.
- Multi-stage Docker build with a compiled Rust brain.

## Architecture

```text
Discord slash commands
        |
        v
Node.js bot/controller
        |
        v
Queue manager ---- health server
        |
        v
Session runner
   |          |          |
   v          v          v
Puppeteer   WebSocket   Rust brain
browser     Engine.IO   state machine
bootstrap   terminal    JSON IPC
```

### Main Components

| Component | Responsibility |
| --- | --- |
| `index.js` | Startup, setup, health server, scheduler, Discord bot, graceful shutdown |
| `src/bot.js` | Discord slash-command registration, permission checks, operator actions |
| `src/manager.js` | Queue processing, retries, deferrals, kill-switch, daily reset |
| `src/runner.js` | Per-session orchestration across browser, WebSocket, and Rust brain |
| `src/browser-controller.js` | Puppeteer lifecycle, cookie injection, Start/Stop UI control |
| `src/websocket-client.js` | Engine.IO handshake, ping/pong, terminal event parsing, command sending |
| `src/brain.js` | Rust child-process lifecycle and newline-delimited JSON IPC |
| `evertext_brain/src/main.rs` | Rust terminal state machine and parsing logic |
| `src/db.js` | lowdb persistence, AES encryption, account/status/settings storage |
| `src/health-server.js` | `/health` and `/ping` liveness/status endpoints |

## Key Engineering Decisions

- **Node.js for orchestration:** Browser control, WebSocket I/O, Discord operations, and queue management are naturally event-driven.
- **Rust for terminal decisions:** The most deterministic and parsing-heavy logic lives in a compiled state machine with explicit enum states.
- **Hybrid browser/WebSocket approach:** Puppeteer establishes browser-authenticated state, then WebSocket handles terminal streams directly.
- **Newline-delimited JSON IPC:** The parent and child process exchange one JSON object per line; Node buffers partial stdout chunks before parsing.
- **Local encrypted persistence:** Sensitive restore/session values are encrypted before writing to `db.json`.
- **Sequential execution:** The queue intentionally runs one terminal session at a time to avoid remote capacity conflicts and simplify recovery.

## Configuration

Copy `.env.example` to `.env` and set values for your authorized target environment.

Required for real operation:

```env
DISCORD_TOKEN=your_discord_bot_token_here
GAME_URL=https://example.com
WS_BASE_URL=wss://example.com/socket.io/?EIO=4&transport=websocket
```

Useful optional values:

```env
TARGET_NAME=Terminal Service
GUILD_ID=your_guild_id_here
LOG_CHANNEL_ID=your_channel_id_here
LOG_LEVEL=INFO
PORT=3000
ENCRYPTION_KEY=replace_with_a_random_secret
```

`GAME_URL` is used for browser navigation, cookie scoping, and WebSocket origin/host headers. `WS_BASE_URL` is used for the Engine.IO WebSocket connection.

## Setup

Install dependencies:

```bash
npm ci
```

Build or check the Rust decision engine:

```bash
cargo check --manifest-path evertext_brain/Cargo.toml
cargo build --release --manifest-path evertext_brain/Cargo.toml
```

Start the application:

```bash
npm start
```

On first run, the setup script can help create a local `.env` file.

## Testing

Run Node.js tests:

```bash
npm test
```

Run Rust tests:

```bash
cargo test --manifest-path evertext_brain/Cargo.toml
```

Run a Rust compile check:

```bash
cargo check --manifest-path evertext_brain/Cargo.toml
```

CI runs these checks on push and pull request through GitHub Actions.

## Docker Deployment

The `Dockerfile` uses a multi-stage build:

- Builder stage installs Rust and compiles the Rust brain.
- Runner stage installs Chromium dependencies and runs the Node.js app.

Build locally:

```bash
docker build -t hybrid-terminal-automation-framework .
```

Run with an environment file:

```bash
docker run --env-file .env -p 3000:3000 hybrid-terminal-automation-framework
```

## Health Endpoint

The app exposes:

- `GET /health`
- `GET /ping`

The response includes process uptime, memory usage, last activity time, queue status, active account label, and whether the Rust brain is currently running. It does not expose cookies, restore codes, or other credentials.

## Responsible Use

This project is intended for authorized automation, controlled testing, and engineering education. Do not use it against services where automation is prohibited or where you do not have permission. Keep credentials and local databases out of version control, respect rate limits, and prefer explicit approval from service owners before automating a target.
Thank You

## Limitations

- The current Rust state machine still models one terminal workflow. To make the framework fully reusable, prompt patterns and transition rules should be moved into a target adapter.
- IPC is newline-delimited JSON. This is simple and testable, but a length-prefixed protocol would be stronger for arbitrary multi-line payloads.
- The local `lowdb` store is appropriate for a single-operator deployment, not a multi-tenant service.

## Roadmap

- Move target prompt strings and command choices into a dedicated adapter config.
- Add more integration tests around the Node/Rust IPC boundary.
- Expand health reporting with WebSocket connection state and last successful action timestamp.
- Add a small local dashboard for queue and health visibility.
