/**
 * @module types
 * @description JSDoc type definitions for the Evertext automation framework.
 */

/**
 * @typedef {Object} Account
 * @property {string} id - Unique timestamp-based identifier
 * @property {string} name - User-assigned display name
 * @property {string} encryptedCode - AES-encrypted restore code
 * @property {string} targetServer - Server identifier (e.g. "E-15") or "All"
 * @property {string} [lastRun] - ISO 8601 timestamp of last execution
 * @property {import('./constants.js').ACCOUNT_STATUS} status - Current processing state
 */

/**
 * @typedef {Object} BrainMessage
 * @property {string} type - Message type (e.g., 'terminal_output')
 * @property {string} content - Raw output from the terminal or server
 * @property {Account} account - The context account for this message
 */

/**
 * @typedef {Object} BrainResponse
 * @property {import('./constants.js').BRAIN_ACTIONS} action - The decided action
 * @property {string} [payload] - Optional data payload for the action
 */

/**
 * @typedef {Object} BrowserSession
 * @property {import('puppeteer').Browser} browser - The active Puppeteer browser instance
 * @property {import('puppeteer').Page} page - The main active page
 */
