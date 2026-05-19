# Architecture Document

## System Components

The Evertext Automation Framework is divided into four highly specialized, decoupled components.

### 1. The Discord Orchestrator (`src/bot.js`, `src/manager.js`)
Serves as the primary user interface and queue manager.
- Accepts slash commands via Discord.js.
- Maintains an in-memory execution queue.
- Handles job retries, exponential backoffs, and scheduling via `node-cron`.
- Manages an emergency kill-switch (`forceStop`).

### 2. The Browser Controller (`src/browser-controller.js`)
A minimal Puppeteer wrapper.
- Launches a shared Chromium instance to save memory.
- Creates isolated Incognito Contexts to inject session cookies.
- Navigates to the target URL and physically interacts with the DOM (clicking "Start" and "Stop") to bootstrap the server-side terminal session.

### 3. The WebSocket Client (`src/websocket-client.js`)
Bypasses the web UI to interact directly with the game server.
- Connects to the Socket.IO endpoints using the injected cookies.
- Captures raw textual data (`output` events).
- Emits events back to the runner (`runSession`) for processing.
- Injects user commands (`input` events) directly into the stream.

### 4. The Rust Decision Engine (`evertext_brain/src/main.rs`)
A deterministic, high-performance state machine.
- Spawned as a child process by Node.js (`src/brain.js`).
- Parses massive strings of unstructured terminal data.
- Employs strict string-matching against predefined constants to determine the exact state of the remote terminal.
- Calculates optimal actions (e.g., parsing dates to find the soonest-expiring event).

---

## Inter-Process Communication (IPC) Protocol

The Node.js Orchestrator and the Rust Decision Engine communicate over `stdin`/`stdout` using single-line JSON payloads.

### Input to Rust (`InputMessage`)

**Initialization:**
```json
{ "type": "init" }
```

**Terminal Data Payload:**
```json
{
  "type": "terminal_output",
  "content": "Raw terminal output string...",
  "account": {
    "code": "decrypted_restore_code",
    "targetServer": "E-15",
    "server_toggle": true
  }
}
```

### Output from Rust (`OutputCommand`)

**Ready Signal:**
```json
{
  "action": "ready",
  "message": "Rust brain initialized"
}
```

**Send Command:**
```json
{
  "action": "send_text",
  "payload": "1",
  "context": "server_selection"
}
```

**System Commands:**
- `{"action": "close_terminal", "reason": "..."}`: Closes the browser UI cleanly.
- `{"action": "restart_terminal", "reason": "..."}`: Restarts the session.
- `{"action": "defer_account", "reason": "..."}`: Bumps the account to the back of the queue.
- `{"action": "wait"}`: No action required; wait for more data.

---

## Data Flow Lifecycle

1. **Queue Dispatch:** `Manager` dequeues an account and calls `Runner.runSession`.
2. **Bootstrapping:** `Runner` spawns `RustBrain`, launches `BrowserController`, and establishes `EvertextWebSocketClient`.
3. **Session Start:** `BrowserController` clicks the UI "Start" button.
4. **The Loop:**
   - `WebSocket` receives terminal text and buffers it.
   - `Runner` periodically sends the buffer via IPC to `RustBrain`.
   - `RustBrain` updates its internal state machine and responds with an `OutputCommand`.
   - `Runner` executes the command (e.g., sending text via `WebSocket`).
5. **Teardown:** `RustBrain` issues `close_terminal`, `Runner` cleans up connections and returns control to `Manager`.
