/**
 * @module logger
 * @description Centralized logging utility with structured log levels and timestamps.
 * Replaces raw console.log with formatted output: [TIMESTAMP] [LEVEL] [MODULE] message
 */

/**
 * @enum {number} Log severity levels
 */
const LOG_LEVELS = {
    ERROR: 0,
    WARN: 1,
    INFO: 2,
    DEBUG: 3
};

// Set this via env var: LOG_LEVEL=ERROR, WARN, INFO, or DEBUG
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;

/**
 * Formats the current date and time as YYYY-MM-DD HH:mm:ss
 * @returns {string} The formatted timestamp string.
 */
function getTimestamp() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

/**
 * Logger class for structured application logging.
 */
class Logger {
    /**
     * @param {string} module - The name of the module originating the logs.
     */
    constructor(module) {
        this.module = module;
    }

    /**
     * Logs an error message (Critical failures, crashes, data loss).
     * @param {...any} args - The messages or objects to log.
     */
    error(...args) {
        if (currentLevel >= LOG_LEVELS.ERROR) {
            console.error(`[${getTimestamp()}] [ERROR] [${this.module}]`, ...args);
        }
    }

    /**
     * Logs a warning message (Issues that should be investigated).
     * @param {...any} args - The messages or objects to log.
     */
    warn(...args) {
        if (currentLevel >= LOG_LEVELS.WARN) {
            console.warn(`[${getTimestamp()}] [WARN ] [${this.module}]`, ...args);
        }
    }

    /**
     * Logs an informational message (Important state changes, user actions).
     * @param {...any} args - The messages or objects to log.
     */
    info(...args) {
        if (currentLevel >= LOG_LEVELS.INFO) {
            console.log(`[${getTimestamp()}] [INFO ] [${this.module}]`, ...args);
        }
    }

    /**
     * Logs a debug message (Detailed flow information, verbose output).
     * @param {...any} args - The messages or objects to log.
     */
    debug(...args) {
        if (currentLevel >= LOG_LEVELS.DEBUG) {
            console.log(`[${getTimestamp()}] [DEBUG] [${this.module}]`, ...args);
        }
    }

    /**
     * Convenience method mapping to info().
     * @param {...any} args - The messages or objects to log.
     */
    log(...args) {
        this.info(...args);
    }
}

/**
 * Factory function to create a new Logger instance.
 * @param {string} module - The name of the module.
 * @returns {Logger} A new Logger instance for the specified module.
 */
export function createLogger(module) {
    return new Logger(module);
}

