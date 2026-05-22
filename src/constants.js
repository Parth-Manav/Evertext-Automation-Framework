/**
 * @module constants
 * @description Centralized configuration and magic values for the Evertext automation framework.
 */

import dotenv from 'dotenv';

dotenv.config();

// --- Timing: session & queue ---
/** @constant {number} Delay between processing individual sessions (10 seconds) */
export const INTER_ACCOUNT_DELAY_MS = 10_000;

/** @constant {number} Delay to defer a session when encountering rate-limit errors (10 minutes) */
export const ZIGZA_DEFER_DELAY_MS = 10 * 60 * 1000;

/** @constant {number} Wait time after defer before retry (10 minutes) — alias of defer delay */
export const DEFER_WAIT_TIME_MS = ZIGZA_DEFER_DELAY_MS;

/** @constant {number} Terminal idle timeout (90 seconds) */
export const IDLE_TIMEOUT_MS = 90_000;

/** @constant {number} Max session duration (20 minutes) */
export const MAX_SESSION_TIME_MS = 1_200_000;

/** @constant {number} Max wait for a terminal slot (10 minutes) */
export const MAX_WAIT_TIME_MS = 600_000;

/** @constant {number} WebSocket connection timeout (10 minutes) */
export const CONNECT_TIMEOUT_MS = 600_000;

/** @constant {number} Wait before retry when terminal is full (30 seconds) */
export const TERMINAL_FULL_RETRY_DELAY_MS = 30_000;

/** @constant {number} Milliseconds per minute (for defer elapsed calculations) */
export const MS_PER_MINUTE = 60_000;

// --- Timing: WebSocket ---
/** @constant {number} Initial WebSocket connection timeout (15 seconds) */
export const WS_CONNECTION_TIMEOUT_MS = 15_000;

/** @constant {number} Send ping before server expects disconnect */
export const WS_PING_INTERVAL_MULTIPLIER = 0.8;

/** @constant {number} Delay between WebSocket commands (300 ms) */
export const WS_COMMAND_DELAY_MS = 300;

/** @constant {number} Polling interval for WebSocket health checks (5 seconds) */
export const WS_PING_INTERVAL_MS = 5_000;

/** @constant {number} Base delay for connection backoff when terminal is full */
export const CONNECTION_BACKOFF_BASE_MS = 5_000;

/** @constant {number} Max connection backoff delay */
export const CONNECTION_BACKOFF_MAX_MS = 60_000;

// --- Timing: browser / Puppeteer ---
/** @constant {number} Max wait time for a Puppeteer action before timing out (30 seconds) */
export const PUPPETEER_TIMEOUT_MS = 30_000;

/** @constant {number} waitForSelector timeout (10 seconds) */
export const PUPPETEER_SELECTOR_TIMEOUT_MS = 10_000;

/** @constant {number} page.goto timeout (15 seconds) */
export const PUPPETEER_NAV_TIMEOUT_MS = 15_000;

/** @constant {number} Poll interval when waiting for stop confirmation */
export const PUPPETEER_STOP_POLL_MS = 200;

/** @constant {number} Timeout when waiting for stop confirmation */
export const PUPPETEER_STOP_CONFIRM_TIMEOUT_MS = 5_000;

/** @constant {number} Wait after clicking Start */
export const BROWSER_WAIT_AFTER_START_MS = 1_000;

/** @constant {number} Wait after clicking Stop */
export const BROWSER_WAIT_AFTER_STOP_MS = 3_000;

/** @constant {number} Wait for process cleanup between sessions */
export const BROWSER_PROCESS_CLEANUP_MS = 5_000;

/** @constant {number} Wait for initial terminal data */
export const BROWSER_INITIAL_DATA_WAIT_MS = 2_000;

/** @constant {number} Extra wait if no initial data received */
export const BROWSER_EXTRA_WAIT_MS = 3_000;

/** @constant {number} Wait after WebSocket reconnect */
export const BROWSER_RECONNECT_WAIT_MS = 2_000;

/** @constant {number} Delay in brain wait loop */
export const BRAIN_WAIT_LOOP_MS = 1_500;

/** @constant {number} Delay after terminal restart */
export const TERMINAL_RESTART_WAIT_MS = 2_000;

// --- Timing: brain ---
/** @constant {number} Max wait for brain IPC response (30 seconds) */
export const BRAIN_RESPONSE_TIMEOUT_MS = 30_000;

/** @constant {number} Size of the history buffer in the Rust state machine */
export const BRAIN_HISTORY_BUFFER_SIZE = 10_000;

// --- Timing: maintenance ---
/** @constant {number} Max age of log/temp files before rotation (24 hours) */
export const LOG_ROTATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// --- Retry logic ---
/** @constant {number} Max retries per session */
export const MAX_RETRY_ATTEMPTS = 3;

/** @constant {number} Max times a session can enter a defer cycle */
export const MAX_DEFER_CYCLES = 3;

// --- Terminal capacity ---
/** @constant {number} Default terminal capacity */
export const DEFAULT_MAX_USERS = 4;

/** @constant {number} Check slot availability interval */
export const SLOT_CHECK_INTERVAL_MS = 1_000;

// --- Context windows ---
/** @constant {number} Characters to send for server selection context */
export const SERVER_LIST_CONTEXT_CHARS = 5_000;

/** @constant {number} Characters to send for event list context */
export const EVENT_LIST_CONTEXT_CHARS = 3_000;

/** @constant {number} Short preview length for debug logging */
export const TERMINAL_PREVIEW_CHARS = 150;

/** @constant {number} Threshold below which WebSocket output is logged in full */
export const WS_VERBOSE_OUTPUT_THRESHOLD = 500;

// --- Brain IPC ---
/** @enum {string} Valid actions that the Rust Brain can return */
export const BRAIN_ACTIONS = {
    SEND_TEXT: 'send_text',
    CLOSE: 'close_terminal',
    RESTART: 'restart_terminal',
    DEFER: 'defer_account',
    WAIT: 'wait',
    READY: 'ready'
};

// --- Game commands ---
/** @enum {string} Interactive commands used within the target application terminal */
export const GAME_COMMANDS = {
    RESTORE: 'd',
    CONFIRM: 'y',
    AUTO: 'auto',
    EXIT: 'exit'
};

// --- Account states ---
/** @enum {string} Execution states for a session */
export const ACCOUNT_STATUS = {
    IDLE: 'idle',
    PENDING: 'pending',
    RUNNING: 'running',
    DONE: 'done',
    ERROR: 'error',
    DEFERRED: 'deferred'
};

// --- Terminal string patterns (must match Rust MSG_* constants) ---
/** @constant {string} Server selection prompt */
export const TERMINAL_MSG_WHICH_ACC_LOGIN = 'Which acc u want to Login';

/** @constant {string} Event list prompt prefix */
export const TERMINAL_MSG_SELECT_EVENT = 'Select the Event [';

// --- Error message codes (preserved for backward-compatible comparisons) ---
/** @constant {string} Session cookie expired */
export const ERROR_CODE_LOGIN_REQUIRED = 'LOGIN_REQUIRED';

/** @constant {string} Terminal idle timeout */
export const ERROR_CODE_IDLE_TIMEOUT = 'IDLE_TIMEOUT';

/** @constant {string} WebSocket connection failed */
export const ERROR_CODE_CONNECTION_FAILED = 'CONNECTION_FAILED';

/** @constant {string} Human-readable target name for logs and docs */
export const TARGET_NAME = process.env.TARGET_NAME?.trim() || 'Terminal Service';

/** @constant {string} Target terminal web URL */
export const GAME_URL = process.env.GAME_URL?.trim() || 'https://example.com';

/** @constant {string} WebSocket base URL (Socket.IO over Engine.IO) */
export const WS_BASE_URL = process.env.WS_BASE_URL?.trim() || 'wss://example.com/socket.io/?EIO=4&transport=websocket';

/** @constant {number} Silence threshold before emitting connection timeout (2 minutes) */
export const WS_ACTIVITY_SILENCE_MS = 120_000;

/** @constant {number} Interval for WebSocket activity health checks */
export const WS_ACTIVITY_CHECK_INTERVAL_MS = 30_000;

/** @constant {number} Grace period before force-killing the brain process */
export const BRAIN_SHUTDOWN_GRACE_MS = 5_000;
