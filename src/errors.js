/**
 * @module errors
 * @description Custom typed errors for structured error handling across the framework.
 */

/**
 * Thrown when a browser session expires or cookies are invalid.
 */
export class SessionExpiredError extends Error {
    constructor(message = 'Browser session expired or cookies invalid') {
        super(message);
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
 * Thrown when the target game server imposes a rate limit or returns a specific error state.
 */
export class ZigzaError extends Error {
    constructor(message = 'Encountered Zigza error or rate limit') {
        super(message);
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
