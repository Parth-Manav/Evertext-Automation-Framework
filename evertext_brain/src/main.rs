//! Evertext Brain - Rust State Machine
//! 
//! This module acts as the autonomous decision engine for the Evertext hybrid bot.
//! It communicates with the Node.js runner via a strict JSON over stdin/stdout IPC protocol.
//!
//! # IPC Protocol
//! - **Input** (stdin): The Node.js parent sends JSON objects representing `InputMessage`.
//!   Each message contains the current raw terminal output and account context.
//! - **Output** (stdout): The Rust brain responds with JSON objects representing `OutputCommand`.
//!   These commands instruct the Node.js parent on what text to send over the WebSocket,
//!   or when to close/restart the terminal.
//!
//! This design isolates the complex state machine logic and string parsing from the
//! asynchronous I/O and browser control handled by Node.js.

use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Write};

// ─────────────────────────────────────────────
//  Terminal String Match Constants
// ─────────────────────────────────────────────

/// Terminal output when an invalid command is sent and the script terminates.
const MSG_INVALID_COMMAND: &str = "Invalid Command";
/// Accompanying text when an invalid command terminates the script.
const MSG_EXITING_NOW: &str = "Exiting Now";
/// Terminal output when the Zigza game server rejects the connection or code.
const MSG_ZIGZA_ERROR: &str = "Either Zigza error or Incorrect Restore Code";
/// Terminal output when the specific game server shard is at capacity.
const MSG_SERVER_FULL: &str = "Server reached maximum limit";
/// Initial prompt indicating the terminal script has started successfully.
const MSG_ENTER_COMMAND_TO_USE: &str = "Enter Command to use";
/// Prompt asking for the player's restore code.
const MSG_ENTER_RESTORE_CODE: &str = "Enter Restore code";
/// Prompt asking to select a server shard (only shown for multi-server accounts).
const MSG_WHICH_ACC_LOGIN: &str = "Which acc u want to Login";
/// Partial match for the mana spending prompt.
const MSG_SPEND_MANA: &str = "spend mana on event stages";
/// Partial match for the mana spending prompt (variation).
const MSG_PRESS_Y_MANA: &str = "Press y to spend mana";
/// Full prompt asking if the bot should spend mana on events.
const MSG_PRESS_Y_EVENT: &str = "Press y to spend mana on event stages";
/// The standard interactive menu prompt.
const MSG_ENTER_CHOICE: &str = "Enter your choice [a / b / c / d]";
/// Prompt asking the user to pick a specific event from a list.
const MSG_SELECT_EVENT: &str = "Select the Event [";
/// Prompt inside the event menu asking for the next action.
const MSG_ENTER_COMMAND: &str = "ENTER COMMAND:";
/// Terminal message indicating the Python script has finished successfully.
const MSG_PROCESS_ENDED: &str = "Process ended with return code 0";
/// Menu item representing all servers.
const MSG_ALL_OF_THEM: &str = "ALL OF THEM";
/// Prefix used in the terminal for numbered list items.
const PREFIX_ARROW: &str = "-->";

/// Default deserialization value for `server_toggle` (true).
fn default_true() -> bool {
    true
}

// ─────────────────────────────────────────────
//  I/O Message Types
// ─────────────────────────────────────────────

/// Represents an incoming JSON message from the Node.js parent.
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum InputMessage {
    /// Sent when the brain process is first spawned.
    #[serde(rename = "init")]
    Init,
    /// Contains the latest terminal output buffer and account context.
    #[serde(rename = "terminal_output")]
    TerminalOutput {
        /// The raw text output from the terminal.
        content: String,
        /// The account settings context for this session.
        account: AccountInfo,
    },
}

/// Contains account configuration and context for decision making.
#[derive(Debug, Deserialize, Clone)]
pub struct AccountInfo {
    /// The AES-decrypted restore code.
    pub code: String,
    /// The target server designation (e.g., "E-15" or "All").
    #[serde(rename = "targetServer")]
    pub target_server: String,
    /// Whether the server selection menu should be expected.
    #[serde(default = "default_true", rename = "server_toggle")]
    pub server_toggle: bool,
}

/// Represents an outgoing JSON command sent to the Node.js parent.
#[derive(Debug, Serialize)]
#[serde(tag = "action")]
pub enum OutputCommand {
    /// Indicates the brain has initialized and is ready to receive input.
    #[serde(rename = "ready")]
    Ready { 
        /// A descriptive readiness message.
        message: String 
    },
    /// Instructs the parent to send specific text over the WebSocket.
    #[serde(rename = "send_text")]
    SendText { 
        /// The text to send to the terminal.
        payload: String, 
        /// Optional context describing the action (e.g., "event_selection").
        context: Option<String> 
    },
    /// Instructs the parent to gracefully close the terminal session.
    #[serde(rename = "close_terminal")]
    CloseTerminal { 
        /// The reason for closing.
        reason: String 
    },
    /// Instructs the parent to forcefully restart the terminal session.
    #[serde(rename = "restart_terminal")]
    RestartTerminal { 
        /// The reason for restarting.
        reason: String 
    },
    /// Instructs the parent to stop processing this account and defer it to the end of the queue.
    #[serde(rename = "defer_account")]
    DeferAccount { 
        /// The reason for deferral.
        reason: String 
    },
    /// Instructs the parent to do nothing and wait for more terminal output.
    #[serde(rename = "wait")]
    Wait,
}

// ─────────────────────────────────────────────
//  State Machine States
// ─────────────────────────────────────────────

/// Represents the current phase of the automation workflow.
#[derive(Debug, Clone, PartialEq)]
pub enum BotState {
    /// **Trigger**: Terminal just connected.
    /// **Waits For**: `MSG_ENTER_COMMAND_TO_USE` before transitioning to `WaitingForCodePrompt`.
    Initial,
    /// **Trigger**: Sent "d" (direct login option).
    /// **Waits For**: `MSG_ENTER_RESTORE_CODE` before transitioning to `WaitingForServerList` (if toggle on) or `WaitingForManaPrompt`.
    WaitingForCodePrompt,
    /// **Trigger**: Sent restore code.
    /// **Waits For**: `MSG_WHICH_ACC_LOGIN` before transitioning to `WaitingForManaPrompt`.
    WaitingForServerList,
    /// **Trigger**: Sent server index (or bypassed server list).
    /// **Waits For**: `MSG_PRESS_Y_EVENT` before transitioning to `WaitingForFirstChoice`.
    WaitingForManaPrompt,
    /// **Trigger**: Sent "y" to confirm mana spending.
    /// **Waits For**: `MSG_ENTER_CHOICE` before transitioning to `WaitingForEventList`.
    WaitingForFirstChoice,
    /// **Trigger**: Sent "a" to select the event menu.
    /// **Waits For**: `MSG_SELECT_EVENT` before transitioning to `WaitingForCommand`.
    WaitingForEventList,
    /// **Trigger**: Sent the selected event index.
    /// **Waits For**: `MSG_ENTER_COMMAND` before transitioning to `WaitingForSecondChoice`.
    WaitingForCommand,
    /// **Trigger**: Sent "auto" to start auto-battling.
    /// **Waits For**: `MSG_ENTER_CHOICE` or `MSG_PROCESS_ENDED` before transitioning to `Finished`.
    WaitingForSecondChoice,
    /// **Trigger**: Final step completed or process ended.
    /// **Waits For**: The parent process to tear down the session.
    Finished,

    // ── ISOLATED (not reachable by the active state machine) ──────────────
    // Kept for reference / future use. No transition leads here.
    #[allow(dead_code)]
    ManaRefillFlow(ManaRefillStep),
}

/// Sub-steps for the legacy mana-refill flow (isolated, not used).
#[derive(Debug, Clone, PartialEq)]
#[allow(dead_code)]
pub enum ManaRefillStep {
    WaitingForYes,
    WaitingForPotionSelection,
    WaitingForAmount,
}

// ─────────────────────────────────────────────
//  Session
// ─────────────────────────────────────────────

/// Maintains the state and history for a single execution sequence.
pub struct BotSession {
    /// The current phase in the state machine.
    pub state: BotState,
    /// The active account configuration.
    pub account: Option<AccountInfo>,
    /// A rolling buffer of recent terminal output to provide context.
    pub history: String,
}

impl BotSession {
    /// Creates a new, uninitialized `BotSession`.
    pub fn new() -> Self {
        BotSession {
            state: BotState::Initial,
            account: None,
            history: String::new(),
        }
    }

    /// Resets the session state back to `Initial` and clears history.
    pub fn reset(&mut self) {
        self.state = BotState::Initial;
        self.history.clear();
        self.account = None;
    }

    // ── Main dispatch ────────────────────────────────────────────────────

    /// Processes new terminal output, updates state, and returns the next command.
    ///
    /// # Arguments
    /// * `content` - The newest chunk of text from the terminal.
    /// * `account` - The context of the current account running.
    pub fn process(&mut self, content: &str, account: &AccountInfo) -> OutputCommand {
        // Persist account info on first call
        if self.account.is_none() {
            self.account = Some(account.clone());
        }

        // Append to rolling history (capped at 15 000 chars → trimmed to 10 000)
        self.history.push_str(content);
        if self.history.len() > 15_000 {
            let drain_to = self.history.len() - 10_000;
            let safe = (0..=3)
                .map(|i| drain_to.saturating_sub(i))
                .find(|&i| self.history.is_char_boundary(i))
                .unwrap_or(0);
            if safe > 0 {
                self.history.drain(..safe);
            }
        }

        // ── Priority error checks (run in every state) ───────────────────
        if content.contains(MSG_INVALID_COMMAND) && content.contains(MSG_EXITING_NOW) {
            return OutputCommand::RestartTerminal {
                reason: "Invalid Command error".to_string(),
            };
        }
        if content.contains(MSG_ZIGZA_ERROR) {
            return OutputCommand::DeferAccount {
                reason: "Zigza error / bad restore code - deferring".to_string(),
            };
        }
        if content.contains(MSG_SERVER_FULL) {
            return OutputCommand::RestartTerminal {
                reason: "Server full".to_string(),
            };
        }

        // ── State machine ────────────────────────────────────────────────
        match &self.state.clone() {

            // ── Step 1: Send "d" to reach the restore-code prompt ─────────
            BotState::Initial => {
                if content.contains(MSG_ENTER_COMMAND_TO_USE) {
                    self.state = BotState::WaitingForCodePrompt;
                    OutputCommand::SendText {
                        payload: "d".to_string(),
                        context: None,
                    }
                } else {
                    OutputCommand::Wait
                }
            }

            // ── Step 2: Send restore code ─────────────────────────────────
            BotState::WaitingForCodePrompt => {
                if content.contains(MSG_ENTER_RESTORE_CODE) {
                    if account.server_toggle {
                        self.state = BotState::WaitingForServerList;
                    } else {
                        self.state = BotState::WaitingForManaPrompt;
                    }
                    OutputCommand::SendText {
                        payload: account.code.clone(),
                        context: None,
                    }
                } else {
                    OutputCommand::Wait
                }
            }

            // ── Step 3 (optional): Send server index ──────────────────────
            BotState::WaitingForServerList => {
                if content.contains(MSG_WHICH_ACC_LOGIN) {
                    self.state = BotState::WaitingForManaPrompt;
                    let index = self
                        .find_server_index(&self.history.clone(), &account.target_server)
                        .unwrap_or(1);
                    OutputCommand::SendText {
                        payload: index.to_string(),
                        context: Some("server_selection".to_string()),
                    }
                } else if content.contains(MSG_SPEND_MANA)
                    || content.contains(MSG_PRESS_Y_MANA)
                {
                    // Single-server account: no selection screen shown
                    self.state = BotState::WaitingForManaPrompt;
                    self.process(content, account)
                } else {
                    OutputCommand::Wait
                }
            }

            // ── Step 4: Confirm mana spend ────────────────────────────────
            BotState::WaitingForManaPrompt => {
                if content.contains(MSG_PRESS_Y_EVENT) {
                    self.state = BotState::WaitingForFirstChoice;
                    OutputCommand::SendText {
                        payload: "y".to_string(),
                        context: None,
                    }
                } else {
                    OutputCommand::Wait
                }
            }

            // ── Step 5: First [a/b/c/d] choice → send "a" ────────────────
            BotState::WaitingForFirstChoice => {
                if content.contains(MSG_ENTER_CHOICE) {
                    self.state = BotState::WaitingForEventList;
                    OutputCommand::SendText {
                        payload: "a".to_string(),
                        context: None,
                    }
                } else {
                    OutputCommand::Wait
                }
            }

            // ── Step 6: Parse event list, pick soonest-expiring ───────────
            BotState::WaitingForEventList => {
                if content.contains(MSG_SELECT_EVENT) {
                    self.state = BotState::WaitingForCommand;

                    // Use the full history so we capture the list even if
                    // "Select the Event" arrived in a different chunk than the list.
                    let best = self.pick_soonest_event(&self.history.clone());
                    eprintln!(
                        "[Rust Brain] Event list parsed. Chosen index: {}",
                        best
                    );
                    OutputCommand::SendText {
                        payload: best.to_string(),
                        context: Some("event_selection".to_string()),
                    }
                } else {
                    OutputCommand::Wait
                }
            }

            // ── Step 7: Inside event → send "auto" ───────────────────────
            BotState::WaitingForCommand => {
                if content.contains(MSG_ENTER_COMMAND) {
                    self.state = BotState::WaitingForSecondChoice;
                    OutputCommand::SendText {
                        payload: "auto".to_string(),
                        context: None,
                    }
                } else {
                    OutputCommand::Wait
                }
            }

            // ── Step 8: Second [a/b/c/d] choice → send "d" (exit) ────────
            BotState::WaitingForSecondChoice => {
                if content.contains(MSG_ENTER_CHOICE) {
                    self.state = BotState::Finished;
                    OutputCommand::SendText {
                        payload: "d".to_string(),
                        context: None,
                    }
                } else if content.contains(MSG_PROCESS_ENDED) {
                    // Terminal ended cleanly before the second prompt arrived
                    self.state = BotState::Finished;
                    OutputCommand::CloseTerminal {
                        reason: "Session complete".to_string(),
                    }
                } else {
                    OutputCommand::Wait
                }
            }

            // ── Final: close the terminal ─────────────────────────────────
            BotState::Finished => {
                if content.contains(MSG_PROCESS_ENDED) {
                    OutputCommand::CloseTerminal {
                        reason: "Session complete".to_string(),
                    }
                } else {
                    OutputCommand::Wait
                }
            }

            // ── ISOLATED legacy mana-refill flow (never reached) ─────────
            BotState::ManaRefillFlow(_) => OutputCommand::Wait,
        }
    }

    // ── Helper: pick the event index with the soonest expiry ─────────────

    /// Parses the history to find the active game events and picks the one expiring soonest.
    ///
    /// Parses lines like:
    ///   `-->1. beautybeaststryone | Coins: 0 | Expires: 18 days 14 hours left`
    ///   `-->2. elizabethstrythree | Coins: 0 | Expires: 2 days 14 hours left`
    ///   `-->3. fludun | Coins: 8430 | Expires: Unknown`
    ///
    /// Returns the 1-based index of the event expiring soonest.
    /// Events with `Expires: Unknown` are treated as expiring last.
    /// Falls back to index 1 if parsing fails entirely.
    pub fn pick_soonest_event(&self, text: &str) -> usize {
        let mut best_index: usize = 1;
        let mut best_hours: u64 = u64::MAX;

        for line in text.lines() {
            let trimmed = line.trim();

            // Match lines that start with -->N.
            if !trimmed.starts_with(PREFIX_ARROW) {
                continue;
            }

            // Extract the numeric index immediately after "-->"
            let after_arrow = &trimmed[PREFIX_ARROW.len()..];
            let dot_pos = match after_arrow.find('.') {
                Some(p) => p,
                None => continue,
            };
            let index: usize = match after_arrow[..dot_pos].trim().parse() {
                Ok(n) => n,
                Err(_) => continue,
            };

            // Extract the "Expires: ..." segment
            let expires_hours = if let Some(exp_start) = trimmed.find("Expires:") {
                let exp_str = trimmed[exp_start + "Expires:".len()..].trim();

                if exp_str.to_lowercase().starts_with("unknown") {
                    u64::MAX // treat unknown as last priority
                } else {
                    // Parse "X days Y hours left" - both parts are optional
                    let mut total_hours: u64 = 0;

                    if let Some(d_pos) = exp_str.find("day") {
                        let days_str = exp_str[..d_pos].trim();
                        // Walk back to find the start of the number
                        let days: u64 = days_str
                            .split_whitespace()
                            .last()
                            .and_then(|s| s.parse().ok())
                            .unwrap_or(0);
                        total_hours += days * 24;
                    }

                    if let Some(h_pos) = exp_str.find("hour") {
                        let before_hour = &exp_str[..h_pos];
                        let hours: u64 = before_hour
                            .split_whitespace()
                            .last()
                            .and_then(|s| s.parse().ok())
                            .unwrap_or(0);
                        total_hours += hours;
                    }

                    total_hours
                }
            } else {
                u64::MAX // no Expires field found → last priority
            };

            eprintln!(
                "[Rust Brain] Event {} → {} total hours until expiry",
                index, expires_hours
            );

            if expires_hours < best_hours {
                best_hours = expires_hours;
                best_index = index;
            }
        }

        best_index
    }

    // ── Helper: find a server's menu index from the listing ──────────────

    /// Parses the server selection listing to find the correct index for a target server.
    pub fn find_server_index(&self, content: &str, target_server: &str) -> Option<usize> {
        let target = target_server.trim().to_uppercase();

        if target == "ALL" {
            for line in content.lines() {
                if line.to_uppercase().contains(MSG_ALL_OF_THEM) {
                    if let Some(index_str) = line.split(PREFIX_ARROW).next() {
                        if let Ok(index) = index_str.trim().parse::<usize>() {
                            return Some(index);
                        }
                    }
                }
            }
            return None;
        }

        for line in content.lines() {
            let line_upper = line.to_uppercase();
            
            if let Some(arrow_idx) = line_upper.find(PREFIX_ARROW) {
                if let Some(pipe_idx) = line_upper.find("||") {
                    if pipe_idx > arrow_idx {
                        let server_info = &line_upper[arrow_idx + PREFIX_ARROW.len()..pipe_idx];
                        
                        let words = server_info.split(|c| c == ' ' || c == '(' || c == ')');
                        let mut is_match = false;
                        
                        for word in words {
                            let w = word.trim();
                            if w.is_empty() { continue; }
                            
                            if w == target {
                                is_match = true;
                                break;
                            } else if let Some(dash_idx) = w.rfind('-') {
                                let number_part = &w[dash_idx + 1..];
                                if number_part == target {
                                    is_match = true;
                                    break;
                                }
                            }
                        }

                        if is_match {
                            if let Some(index_str) = line.split(PREFIX_ARROW).next() {
                                if let Ok(index) = index_str.trim().parse::<usize>() {
                                    return Some(index);
                                }
                            }
                        }
                    }
                }
            }
        }
        None
    }
}

// ─────────────────────────────────────────────
//  Entry point
// ─────────────────────────────────────────────

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    let mut session = BotSession::new();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };

        let input: InputMessage = match serde_json::from_str(&line) {
            Ok(msg) => msg,
            Err(e) => {
                eprintln!("[Rust Brain] Failed to parse input: {}", e);
                continue;
            }
        };

        let response = match input {
            InputMessage::Init => {
                session.reset();
                OutputCommand::Ready {
                    message: "Rust brain initialized".to_string(),
                }
            }
            InputMessage::TerminalOutput { content, account } => {
                session.process(&content, &account)
            }
        };

        let json = serde_json::to_string(&response).unwrap();
        writeln!(stdout, "{}", json).unwrap();
        stdout.flush().unwrap();
    }
}
