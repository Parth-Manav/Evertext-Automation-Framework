/**
 * @module errors
 * @description Custom typed errors for structured error handling across the framework.
 */

import {
    ERROR_CODE_LOGIN_REQUIRED,
    ERROR_CODE_IDLE_TIMEOUT,
    ERROR_CODE_CONNECTION_FAILED
} from './constants.js';

/**
 * Base error with a stable machine-readable code for recovery logic.
 */
export class CodedError extends Error {
    /**
     * @param {string} message - Human-readable error message.
     * @param {string} code - Stable error code for branching logic.
     */
    constructor(message, code) {
        super(message);
        this.name = 'CodedError';
        /** @type {string} */
        this.code = code;
    }
}

/**
 * Thrown when a browser session expires or cookies are invalid.
 */
export class SessionExpiredError extends CodedError {
    constructor(message = 'Browser session expired or cookies invalid') {
        super(message, ERROR_CODE_LOGIN_REQUIRED);
        this.name = 'SessionExpiredError';
    }
}

/**
 * Thrown when IPC communication with the Rust Brain fails.
 */
export class BrainCommunicationError extends Error {
    constructor(message = 'Failed to communicate with the Rust Brain process') {
        super(message);
        this.name = 'BrainCommunicationError';
    }
}

/**
 * Thrown when the target service imposes a rate limit (Zigza / defer path).
 */
export class ZigzaError extends CodedError {
    constructor(message = 'Encountered Zigza error or rate limit') {
        super(message, 'ZIGZA_DEFER');
        this.name = 'ZigzaError';
    }
}

/**
 * Thrown when the requested target server is full or unavailable.
 */
export class ServerFullError extends Error {
    constructor(message = 'Target server is full or unavailable') {
        super(message);
        this.name = 'ServerFullError';
    }
}

/**
 * Thrown when input validation fails for commands or IPC messages.
 */
export class ValidationError extends Error {
    constructor(message = 'Input validation failed') {
        super(message);
        this.name = 'ValidationError';
    }
}

/**
 * Thrown when the terminal receives no new output within the idle window.
 */
export class IdleTimeoutError extends CodedError {
    constructor(message = 'Terminal idle timeout') {
        super(message, ERROR_CODE_IDLE_TIMEOUT);
        this.name = 'IdleTimeoutError';
    }
}

/**
 * Thrown when the WebSocket connection is rejected (terminal at capacity).
 */
export class ConnectionFailedError extends CodedError {
    constructor(message = 'WebSocket connection rejected') {
        super(message, ERROR_CODE_CONNECTION_FAILED);
        this.name = 'ConnectionFailedError';
    }
}

/**
 * Returns true if the error matches a known code (typed or legacy message).
 * @param {unknown} err - Caught error value.
 * @param {string} code - Error code constant to match.
 * @returns {boolean}
 */
export function isErrorCode(err, code) {
    if (err && typeof err === 'object' && 'code' in err && err.code === code) return true;
    return err instanceof Error && err.message === code;
}
