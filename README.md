<div align="center">
  <h1>Evertext Automation Framework</h1>
  <p><strong>A production-grade, event-driven hybrid automation framework</strong></p>
  
  <!-- Add a hero banner or the main demonstration video here -->
  <p>
    <em>[Insert main demonstration video/GIF of the bot running here]</em>
  </p>
</div>

<br />

The **Evertext Automation Framework** is designed to interface with real-time WebSocket streams, manage headless browser sessions, and execute deterministic state machine logic via Inter-Process Communication (IPC). It is built to handle complex, long-running automation tasks that require high reliability and precise state management.

## 📑 Table of Contents
- [Demonstrations](#-demonstrations)
- [Architecture Overview](#-architecture-overview)
- [Tech Stack](#-tech-stack)
- [Core Features](#-core-features)
- [Setup & Execution](#-setup--execution)
- [Deployment](#-deployment)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🎥 Demonstrations

*(Replace the placeholders below with links to your short videos or GIFs showcasing the bot)*

### 1. Discord Interface & Command Orchestration
Watch how the Discord bot handles concurrent execution commands, manages the queue, and reports live status via rich embeds.
> **[Insert Discord interaction video here]**

### 2. Hybrid Browser & Terminal Automation
See Puppeteer inject cookies and bootstrap the game interface, while the custom WebSocket client seamlessly takes over the terminal stream.
> **[Insert browser/terminal execution video here]**

### 3. Rust Decision Engine (Sub-millisecond Parsing)
A look at the Rust state machine processing complex server listings and event choices in real-time, executing logic autonomously.
> **[Insert Rust logging/decision video here]**

---

## 🏗 Architecture Overview

It leverages a polyglot architecture to maximize performance and maintainability:

- **Node.js Orchestration Layer:** Manages job queues, Discord.js command handling, and process lifecycle.
- **Puppeteer Headless Automation:** Initializes and manages headless Chromium contexts for secure, isolated cookie injection and session bootstrapping.
- **WebSocket Client:** Connects directly to the underlying Socket.IO streams, bypassing the UI layer to capture raw terminal output and inject commands with millisecond latency.
- **Rust State Machine (`evertext_brain`):** A high-performance, deterministic decision engine compiled to a native binary. It communicates with the Node.js layer via standard I/O (stdin/stdout) using a strict JSON schema, parsing massive terminal logs and calculating optimal actions in under a millisecond.

For a detailed breakdown of the internal systems, data flows, and IPC schemas, please see **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## 🛠 Tech Stack

| Component | Technology | Purpose |
| :--- | :--- | :--- |
| **Orchestrator** | Node.js, Discord.js | CLI/Discord Bot interface, Job Queue Management, CRON Scheduling |
| **Decision Engine** | Rust (`cargo`) | High-speed terminal parsing and deterministic state management |
| **Browser Context**| Puppeteer | Session bootstrapping and secure cookie injection |
| **Networking** | `ws` (WebSocket) | Raw Socket.IO stream interception and command injection |
| **Database** | `lowdb`, `crypto-js` | Lightweight JSON store with AES-encrypted credential storage |

---

## ✨ Core Features

- **Decoupled Architecture:** The browser, WebSocket, and decision engine operate independently. The browser is used strictly for authentication and connection bootstrapping, freeing up system resources.
- **Robust Error Handling:** Custom typed error classes (`SessionExpiredError`, `ServerFullError`, etc.) ensure predictable recovery from network interruptions and server-side timeouts.
- **Dynamic Queue Management:** The `Manager` handles concurrent accounts, implementing exponential backoffs, automatic deferrals, and job retries without blocking the event loop.
- **Structured Logging:** A centralized logging module filters output based on severity (`INFO`, `WARN`, `ERROR`, `DEBUG`) and seamlessly bridges internal application logs with Discord webhook alerts.
- **Secure Credential Storage:** Employs AES symmetric encryption at rest to securely store user credentials locally.

---

## 🚀 Setup & Execution

### Prerequisites
- **Node.js** (v18 or higher)
- **Rust** (Cargo toolchain)
- A **Discord Bot Token** (for the UI interface)

### Installation

1. **Clone the repository:**
   ```bash
    git clone https://github.com/Parth-Manav/Evertext-self-bot.git
    cd Evertext-self-bot
   ```

2. **Install Node.js dependencies:**
   ```bash
   npm install
   ```

3. **Compile the Rust decision engine:**
   ```bash
   cd evertext_brain
   cargo build --release
   cd ..
   ```

4. **Environment Configuration:**
   Copy the example config and fill in your variables (like `DISCORD_TOKEN`).
   ```bash
   cp .env.example .env
   ```

### Running the Application

```bash
npm start
```

---

## ☁️ Deployment

For production deployments, it is recommended to run the bot using a process manager like `pm2`:
```bash
npm install -g pm2
pm2 start index.js --name "evertext-bot"
```

---

## 🤝 Contributing

Please review **[CONTRIBUTING.md](CONTRIBUTING.md)** for coding standards, pull request guidelines, and local development setup instructions.

---

## 📄 License

This project is licensed under the MIT License. See the `LICENSE` file for details.
