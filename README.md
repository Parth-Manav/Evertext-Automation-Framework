# Evertext Automation Framework

A production-grade hybrid automation system demonstrating multi-process inter-process communication (IPC), browser session management, and event-driven WebSocket orchestration.

## Technical Highlights

- **Hybrid architecture:** Puppeteer manages long-lived browser sessions while a raw WebSocket client handles real-time bidirectional communication — chosen to solve the session-longevity vs. performance tradeoff
- **Cross-language IPC:** Node.js orchestrator communicates with a Rust decision engine via JSON over stdin/stdout pipes
- **State machine in Rust:** Deterministic, typed state transitions ensure predictable behavior across all execution paths
- **AES-encrypted storage:** Credentials stored with symmetric encryption using a user-provided key; never stored in plaintext
- **Discord bot interface:** Slash command API for queue control, scheduling, and real-time status updates
- **Docker-ready:** Single-container deployment with environment injection

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Discord Slash Commands                          │
│                    (queue control, scheduling, status)                  │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Manager (src/manager.js)                                               │
│  • Sequential session queue    • Kill-switch    • 10-min defer/retry    │
│  • Shared browser reuse        • Daily cron reset                       │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │ runSession()
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Runner (src/runner.js) — per-session orchestration                     │
│  ┌──────────────┐  ┌──────────────────┐  ┌─────────────────────────┐  │
│  │ Browser      │  │ WebSocket Client │  │ Rust Brain (child proc) │  │
│  │ Controller   │  │ (Socket.IO/ws)   │  │ stdin/stdout JSON IPC   │  │
│  │ Puppeteer    │  │ terminal I/O     │  │ state machine decisions │  │
│  └──────────────┘  └──────────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  lowdb + AES (src/db.js) — encrypted credentials, schedule, cookies     │
└─────────────────────────────────────────────────────────────────────────┘
```

## Why This Architecture?

| Concern | Browser-only | WebSocket-only | This hybrid |
|--------|--------------|----------------|-------------|
| Session longevity (cookies 24h+) | Strong | Weak (no DOM bootstrap) | Strong — Puppeteer injects cookies |
| Real-time I/O latency | Poor (DOM polling) | Strong | Strong — WebSocket after bootstrap |
| Stateful decision logic | Fragile in JS | Fragile in JS | Strong — Rust state machine |
| Resource usage | High per session | Low | Medium — one shared browser, many WS connections |
| Determinism | Low | Medium | High — typed Rust transitions |

## Component Breakdown

| Component | Path | Responsibility |
|-----------|------|----------------|
| **Entry / lifecycle** | `index.js` | Startup, orphan Chrome cleanup, health server, graceful shutdown |
| **Discord orchestrator** | `src/bot.js` | Slash commands, permissions, Discord log embeds |
| **Queue manager** | `src/manager.js` | Scheduling, retries, defer queue, kill-switch, shared browser |
| **Session runner** | `src/runner.js` | Wires browser + WebSocket + brain for one session |
| **Browser controller** | `src/browser-controller.js` | Chromium launch, cookie injection, Start/Stop UI |
| **WebSocket client** | `src/websocket-client.js` | Engine.IO handshake, terminal `output`/`input` events |
| **Brain IPC wrapper** | `src/brain.js` | Spawns Rust binary, JSON stdin/stdout |
| **Decision engine** | `evertext_brain/src/main.rs` | Terminal parsing, state machine, action emission |
| **Encrypted store** | `src/db.js` | lowdb JSON + AES for restore codes and settings |
| **Structured logging** | `src/logger.js` | Timestamped, leveled, module-prefixed logs |

## IPC Protocol Specification

Communication is **one JSON object per line** on stdin (Node → Rust) and stdout (Rust → Node).

### Input (Node → Rust)

**Initialize:**
```json
{ "type": "init" }
```

**Terminal output:**
```json
{
  "type": "terminal_output",
  "content": "raw terminal text...",
  "account": {
    "name": "session-label",
    "code": "decrypted-restore-code",
    "targetServer": "E-15",
    "server_toggle": true
  }
}
```

### Output (Rust → Node)

| `action` | Fields | Meaning |
|----------|--------|---------|
| `ready` | `message` | Brain process initialized |
| `send_text` | `payload`, `context?` | Send text to terminal via WebSocket |
| `close_terminal` | `reason` | Session complete — stop browser terminal |
| `restart_terminal` | `reason` | Stop and re-bootstrap terminal + WS |
| `defer_account` | `reason` | Rate limit — defer session 10 minutes |
| `wait` | — | No action; wait for more terminal output |

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full lifecycle and state diagram.

## State Machine Documentation

Rust `BotState` variants (see `evertext_brain/src/main.rs`):

| State | Trigger (send) | Waits for (terminal) | Next state |
|-------|----------------|----------------------|------------|
| `Initial` | — | `Enter Command to use` | `WaitingForCodePrompt` |
| `WaitingForCodePrompt` | `d` | `Enter Restore code` | `WaitingForServerList` or `WaitingForManaPrompt` |
| `WaitingForServerList` | restore code | `Which acc u want to Login` | `WaitingForManaPrompt` |
| `WaitingForManaPrompt` | server index | `Press y to spend mana on event stages` | `WaitingForFirstChoice` |
| `WaitingForFirstChoice` | `y` | `Enter your choice [a / b / c / d]` | `WaitingForEventList` |
| `WaitingForEventList` | `a` | `Select the Event [` | `WaitingForCommand` |
| `WaitingForCommand` | event index | `ENTER COMMAND:` | `WaitingForSecondChoice` |
| `WaitingForSecondChoice` | `auto` | choice menu or process ended | `Finished` |
| `Finished` | — | parent teardown | — |

## Error Handling Strategy

| Error | Detection | Recovery |
|-------|-----------|----------|
| `SessionExpiredError` | Login page detected (`LOGIN_REQUIRED`) | Retry without browser restart; user must `/set_cookies` |
| `IdleTimeoutError` | No terminal output within idle window | Retry without browser restart |
| `ConnectionFailedError` | WS `connection_failed` or terminal full | Exponential backoff; may defer |
| `ServerFullError` | Connect loop timeout | Defer or fail session |
| `ZigzaError` | Brain `defer_account` or terminal full defer | 10-minute defer; max 3 attempts/cycles |
| `BrainCommunicationError` | IPC timeout or process death | Session fails; may retry |
| `ValidationError` | Invalid Discord/DB/IPC input | User-facing error reply |
| Kill-switch | `/force_stop_all` → `forceStop()` | Finish current session; stop queue |

## Installation & Development Setup

### Prerequisites

- Node.js v18+
- Rust (Cargo)
- Discord bot token

### Steps

```bash
git clone https://github.com/Parth-Manav/Evertext-self-bot.git
cd Evertext-self-bot
npm install

cd evertext_brain
cargo build --release
cd ..

cp .env.example .env
# Edit .env with DISCORD_TOKEN and other values

npm start
```

First run may auto-generate `ENCRYPTION_KEY` in `.env`.

## Configuration Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | Yes | Discord bot token |
| `GUILD_ID` | No | Guild ID for instant slash-command registration |
| `LOG_LEVEL` | No | `DEBUG` \| `INFO` \| `WARN` \| `ERROR` (default: `INFO`) |
| `ENCRYPTION_KEY` | Recommended | AES key for `db.json` restore codes |
| `LOG_CHANNEL_ID` | No | Fallback Discord log channel |
| `PORT` | No | Health server port (default: `3000`) |

See [.env.example](.env.example) for examples and where to obtain each value.

## Design Decisions & Tradeoffs

**Why Rust for the decision engine?** Terminal output is unstructured text with branching prompts. Rust provides fast string matching, explicit state enums, and compile-time guarantees without blocking the Node.js event loop.

**Why `ws` instead of raw WebSockets only?** The target service uses Socket.IO over Engine.IO. The client implements the handshake (`0` open, `40` namespace, `42` events, `2`/`3` ping/pong) rather than pulling the full Socket.IO client, keeping dependencies minimal while preserving protocol compatibility.

**Why lowdb instead of SQLite or Postgres?** This is a single-operator tool with a small credential set. A JSON file with atomic writes and AES encryption avoids migration overhead and external services.

**Why a single shared browser instance?** Launching Chromium per session is expensive. One browser with isolated incognito contexts per session balances memory use and cookie injection while the WebSocket layer handles real-time I/O.

---

## Deployment

```bash
npm install -g pm2
pm2 start index.js --name "evertext-bot"
```

See [ZEABUR_DEPLOYMENT.md](ZEABUR_DEPLOYMENT.md) for container deployment.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see `LICENSE`.
