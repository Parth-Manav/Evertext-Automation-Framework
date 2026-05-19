/**
 * @module constants
 * @description Centralized configuration and magic values for the Evertext automation framework.
 */

// --- Timing Constraints ---
/** @constant {number} Delay between processing individual accounts (10 seconds) */
export const INTER_ACCOUNT_DELAY_MS = 10_000;

/** @constant {number} Delay to defer an account when encountering Zigza errors (10 minutes) */
export const ZIGZA_DEFER_DELAY_MS = 10 * 60 * 1000;

/** @constant {number} Max wait time for a Puppeteer action before timing out (30 seconds) */
export const PUPPETEER_TIMEOUT_MS = 30_000;

/** @constant {number} Polling interval for WebSocket health checks (5 seconds) */
export const WS_PING_INTERVAL_MS = 5_000;

// --- Brain IPC ---
/** @constant {number} Size of the history buffer in the Rust state machine */
export const BRAIN_HISTORY_BUFFER_SIZE = 10_000;

/** @enum {string} Valid actions that the Rust Brain can return */
export const BRAIN_ACTIONS = {
    SEND_TEXT: 'send_text',
    CLOSE: 'close_terminal',
    WAIT: 'wait'
};

// --- Game Commands ---
/** @enum {string} Interactive commands used within the target application terminal */
export const GAME_COMMANDS = {
    RESTORE: 'd',
    CONFIRM: 'y',
    AUTO: 'auto',
    EXIT: 'exit'
};

// --- Account States ---
/** @enum {string} Execution states for an account session */
export const ACCOUNT_STATUS = {
    IDLE: 'idle',
    PENDING: 'pending',
    RUNNING: 'running',
    DONE: 'done',
    ERROR: 'error',
    DEFERRED: 'deferred'
};
