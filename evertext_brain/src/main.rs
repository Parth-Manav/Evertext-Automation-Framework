use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Write};

fn default_true() -> bool {
    true
}

// ─────────────────────────────────────────────
//  I/O Message Types
// ─────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum InputMessage {
    #[serde(rename = "init")]
    Init,
    #[serde(rename = "terminal_output")]
    TerminalOutput {
        content: String,
        account: AccountInfo,
    },
}

#[derive(Debug, Deserialize, Clone)]
struct AccountInfo {
    code: String,
    #[serde(rename = "targetServer")]
    target_server: String,
    #[serde(default = "default_true", rename = "server_toggle")]
    server_toggle: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "action")]
enum OutputCommand {
    #[serde(rename = "ready")]
    Ready { message: String },
    #[serde(rename = "send_text")]
    SendText { payload: String, context: Option<String> },
    #[serde(rename = "close_terminal")]
    CloseTerminal { reason: String },
    #[serde(rename = "restart_terminal")]
    RestartTerminal { reason: String },
    #[serde(rename = "defer_account")]
    DeferAccount { reason: String },
    #[serde(rename = "wait")]
    Wait,
}

// ─────────────────────────────────────────────
//  State Machine States
// ─────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
enum BotState {
    /// Terminal just connected - waiting for the first menu.
    Initial,
    /// Sent "d" - waiting for the restore-code prompt.
    WaitingForCodePrompt,
    /// Sent restore code - waiting for the server-selection list (if toggle on).
    WaitingForServerList,
    /// Sent server index - waiting for "Press y to spend mana on event stages :".
    WaitingForManaPrompt,
    /// Sent "y" - waiting for the FIRST "Enter your choice [a / b / c / d]:" prompt.
    WaitingForFirstChoice,
    /// Sent "a" - waiting for the event list + "Select the Event [1/2/3/...]:" prompt.
    WaitingForEventList,
    /// Sent the event index - waiting for "ENTER COMMAND:".
    WaitingForCommand,
    /// Sent "auto" - waiting for the SECOND "Enter your choice [a / b / c / d]:" prompt.
    WaitingForSecondChoice,
    /// Session complete.
    Finished,

    // ── ISOLATED (not reachable by the active state machine) ──────────────
    // Kept for reference / future use. No transition leads here.
    #[allow(dead_code)]
    ManaRefillFlow(ManaRefillStep),
}

/// Sub-steps for the legacy mana-refill flow (isolated, not used).
#[derive(Debug, Clone, PartialEq)]
#[allow(dead_code)]
enum ManaRefillStep {
    WaitingForYes,
    WaitingForPotionSelection,
    WaitingForAmount,
}

// ─────────────────────────────────────────────
//  Session
// ─────────────────────────────────────────────

struct BotSession {
    state: BotState,
    account: Option<AccountInfo>,
    history: String,
}

impl BotSession {
    fn new() -> Self {
        BotSession {
            state: BotState::Initial,
            account: None,
            history: String::new(),
        }
    }

    fn reset(&mut self) {
        self.state = BotState::Initial;
        self.history.clear();
        self.account = None;
    }

    // ── Main dispatch ────────────────────────────────────────────────────

    fn process(&mut self, content: &str, account: &AccountInfo) -> OutputCommand {
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
        if content.contains("Invalid Command") && content.contains("Exiting Now") {
            return OutputCommand::RestartTerminal {
                reason: "Invalid Command error".to_string(),
            };
        }
        if content.contains("Either Zigza error or Incorrect Restore Code") {
            return OutputCommand::DeferAccount {
                reason: "Zigza error / bad restore code - deferring".to_string(),
            };
        }
        if content.contains("Server reached maximum limit") {
            return OutputCommand::RestartTerminal {
                reason: "Server full".to_string(),
            };
        }

        // ── State machine ────────────────────────────────────────────────
        match &self.state.clone() {

            // ── Step 1: Send "d" to reach the restore-code prompt ─────────
            BotState::Initial => {
                if content.contains("Enter Command to use") {
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
                if content.contains("Enter Restore code") {
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
                if content.contains("Which acc u want to Login") {
                    self.state = BotState::WaitingForManaPrompt;
                    let index = self
                        .find_server_index(&self.history.clone(), &account.target_server)
                        .unwrap_or(1);
                    OutputCommand::SendText {
                        payload: index.to_string(),
                        context: Some("server_selection".to_string()),
                    }
                } else if content.contains("spend mana on event stages")
                    || content.contains("Press y to spend mana")
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
                if content.contains("Press y to spend mana on event stages") {
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
                if content.contains("Enter your choice [a / b / c / d]") {
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
                if content.contains("Select the Event [") {
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
                if content.contains("ENTER COMMAND:") {
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
                if content.contains("Enter your choice [a / b / c / d]") {
                    self.state = BotState::Finished;
                    OutputCommand::SendText {
                        payload: "d".to_string(),
                        context: None,
                    }
                } else if content.contains("Process ended with return code 0") {
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
                if content.contains("Process ended with return code 0") {
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

    /// Parses lines like:
    ///   `-->1. beautybeaststryone | Coins: 0 | Expires: 18 days 14 hours left`
    ///   `-->2. elizabethstrythree | Coins: 0 | Expires: 2 days 14 hours left`
    ///   `-->3. fludun | Coins: 8430 | Expires: Unknown`
    ///
    /// Returns the 1-based index of the event expiring soonest.
    /// Events with `Expires: Unknown` are treated as expiring last.
    /// Falls back to index 1 if parsing fails entirely.
    fn pick_soonest_event(&self, text: &str) -> usize {
        let mut best_index: usize = 1;
        let mut best_hours: u64 = u64::MAX;

        for line in text.lines() {
            let trimmed = line.trim();

            // Match lines that start with -->N.
            if !trimmed.starts_with("-->") {
                continue;
            }

            // Extract the numeric index immediately after "-->"
            let after_arrow = &trimmed[3..];
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

    fn find_server_index(&self, content: &str, target_server: &str) -> Option<usize> {
        let target = target_server.trim();

        if target.to_lowercase() == "all" {
            for line in content.lines() {
                if line.contains("All of them") {
                    if let Some(index_str) = line.split("-->").next() {
                        if let Ok(index) = index_str.trim().parse::<usize>() {
                            return Some(index);
                        }
                    }
                }
            }
            return None;
        }

        for line in content.lines() {
            if let Some(start_paren) = line.find('(') {
                if let Some(end_paren) = line.find(')') {
                    if end_paren > start_paren {
                        let code_in_parens = &line[start_paren + 1..end_paren];
                        let is_match = if target.starts_with("E-") || target.starts_with("EA-") {
                            code_in_parens == target
                        } else {
                            let suffix = format!("-{}", target);
                            code_in_parens.ends_with(&suffix)
                        };

                        if is_match {
                            if let Some(index_str) = line.split("-->").next() {
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
