/**
 * @module types
 * @description JSDoc type definitions for the Evertext automation framework.
 */

/**
 * @typedef {'idle'|'pending'|'running'|'done'|'error'|'deferred'} AccountStatus
 */

/**
 * @typedef {Object} Account
 * @property {string} id - Unique timestamp-based identifier
 * @property {string} name - User-assigned display name
 * @property {string} encryptedCode - AES-encrypted restore code
 * @property {string} targetServer - Server identifier (e.g. "E-15") or "All"
 * @property {boolean} [serverToggle] - Whether server-selection flow is enabled
 * @property {string} [lastRun] - ISO 8601 timestamp of last execution
 * @property {AccountStatus} status - Current processing state
 */

/**
 * @typedef {Object} AccountContext
 * @property {string} name - Display name passed to the brain
 * @property {string} code - Decrypted restore code
 * @property {string} targetServer - Target server designation
 * @property {boolean} serverToggle - Server menu toggle
 */

/**
 * @typedef {Object} BrainMessage
 * @property {'init'|'terminal_output'} type - IPC message type
 * @property {string} [content] - Raw terminal output (terminal_output only)
 * @property {AccountContext} [account] - Session context (terminal_output only)
 */

/**
 * @typedef {Object} BrainResponse
 * @property {string} action - Brain command (send_text, close_terminal, wait, etc.)
 * @property {string} [payload] - Text to send when action is send_text
 * @property {string} [context] - Optional context label (e.g. server_selection)
 * @property {string} [reason] - Human-readable reason for close/defer/restart
 * @property {string} [message] - Ready or error message
 */

/**
 * @typedef {Object} SessionResult
 * @property {boolean} success - Whether the session completed successfully
 * @property {string} [reason] - Failure or defer reason
 * @property {boolean} [defer] - True when the session should be deferred in the queue
 * @property {import('./browser-controller.js').BrowserController|null} browser - Shared browser instance
 * @property {boolean} createdBrowser - Whether this session created the browser
 * @property {import('./errors.js').ZigzaError} [error] - Typed error when deferring
 */

/**
 * @typedef {Object} Schedule
 * @property {string} start - Start hour in HH:00 format
 * @property {string} end - End hour in HH:00 format
 */

/**
 * @typedef {Object} CookiePayload
 * @property {string} session - Session cookie value for Puppeteer/WebSocket auth
 */

/**
 * @typedef {'info'|'success'|'warning'|'error'} LogType
 */

/**
 * @typedef {Object} BrowserSession
 * @property {import('puppeteer').Browser} browser - The active Puppeteer browser instance
 * @property {import('puppeteer').Page} page - The main active page
 */
