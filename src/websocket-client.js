/**
 * @module websocket-client
 * @description Manages the raw WebSocket connection to the game's Socket.IO server.
 * Handles the Engine.IO handshake, ping/pong keepalives, and event parsing.
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { createLogger } from './logger.js';
import {
    WS_BASE_URL,
    WS_CONNECTION_TIMEOUT_MS,
    WS_PING_INTERVAL_MULTIPLIER,
    WS_COMMAND_DELAY_MS,
    WS_ACTIVITY_SILENCE_MS,
    WS_ACTIVITY_CHECK_INTERVAL_MS
} from './constants.js';
import { ConnectionFailedError, IdleTimeoutError } from './errors.js';

const logger = createLogger('websocket-client');

/**
 * Custom WebSocket client mimicking a Socket.IO connection.
 * @extends EventEmitter
 */
export class EvertextWebSocketClient extends EventEmitter {
    /**
     * @param {string} sessionCookie - The session cookie to authenticate the connection.
     */
    constructor(sessionCookie) {
        super();
        this.sessionCookie = sessionCookie;
        /** @type {WebSocket | null} */
        this.ws = null;
        /** @type {string | null} */
        this.sid = null;
        /** @type {number | null} */
        this.pingInterval = null;
        /** @type {boolean} */
        this.connected = false;
        /** @type {number} */
        this.lastActivity = Date.now();
        /** @type {NodeJS.Timeout | null} */
        this.activityCheckInterval = null;
    }

    /**
     * Establishes the WebSocket connection and completes the Engine.IO handshake.
     * @returns {Promise<void>} Resolves when the namespace is connected.
     * @throws {Error} If the connection times out or fails.
     */
    async connect() {
        return new Promise((resolve, reject) => {
            const headers = {
                'Cookie': `session=${this.sessionCookie}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Origin': 'https://evertext.sytes.net',
                'Host': 'evertext.sytes.net'
            };

            logger.info('Connecting to EverText terminal...');

            this.ws = new WebSocket(WS_BASE_URL, { headers });

            const timeout = setTimeout(() => {
                reject(new Error(`Connection timeout (${WS_CONNECTION_TIMEOUT_MS / 1000}s)`));
                this.ws?.close();
            }, WS_CONNECTION_TIMEOUT_MS);

            this.ws.on('open', () => {
                logger.info('Connection opened, waiting for handshake...');
            });

            // Socket.IO event chain: open (0) → namespace (40) → events (42) → ping/pong (2/3)
            this.ws.on('message', (rawMessage) => {
                clearTimeout(timeout);
                const message = rawMessage.toString();
                this.lastActivity = Date.now();

                if (message.startsWith('0')) {
                    // Open packet with session info
                    try {
                        const json = JSON.parse(message.substring(1));
                        this.sid = json.sid;
                        this.pingInterval = json.pingInterval || 25000;
                        logger.info(`Connected! Session ID: ${this.sid}`);

                        // Send namespace upgrade
                        this.ws.send('40');
                        this.connected = true;

                        // Start ping interval
                        this._startPing();

                        resolve();
                    } catch (e) {
                        reject(new Error('Failed to parse handshake: ' + e.message));
                    }
                } else if (message === '2') {
                    // Server ping - respond with pong
                    if (this.ws) {
                        this.ws.send('3');
                    }
                } else if (message.startsWith('40')) {
                    // Namespace connected
                    logger.info('Namespace connected. Ready for events.');
                } else if (message.startsWith('42')) {
                    // Event packet
                    this._handleEvent(message);
                }
            });

            this.ws.on('error', (err) => {
                clearTimeout(timeout);
                logger.error('Error:', err.message);
                reject(err);
            });

            this.ws.on('close', () => {
                logger.info('Connection closed');
                this.connected = false;
                this._stopPing();
                this.emit('disconnect');
            });
        });
    }

    /**
     * Starts the ping and activity check intervals.
     * @private
     */
    _startPing() {
        // Send periodic pings to keep connection alive
        this._pingTimer = setInterval(() => {
            if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send('2');
            }
        }, Math.floor(this.pingInterval * WS_PING_INTERVAL_MULTIPLIER));

        this.activityCheckInterval = setInterval(() => {
            const timeSinceActivity = Date.now() - this.lastActivity;
            if (timeSinceActivity > WS_ACTIVITY_SILENCE_MS) {
                logger.warn('No activity for extended silence window - connection may be dead');
                this.emit('error', new Error('CONNECTION_TIMEOUT'));
                this.close();
            }
        }, WS_ACTIVITY_CHECK_INTERVAL_MS);
    }

    /**
     * Stops the ping and activity check intervals.
     * @private
     */
    _stopPing() {
        if (this._pingTimer) {
            clearInterval(this._pingTimer);
            this._pingTimer = null;
        }
        if (this.activityCheckInterval) {
            clearInterval(this.activityCheckInterval);
            this.activityCheckInterval = null;
        }
    }

    /**
     * Parses and emits events from the Socket.IO event packet.
     * @param {string} message - The raw message string starting with '42'.
     * @private
     */
    _handleEvent(message) {
        try {
            const eventData = JSON.parse(message.substring(2));
            const [eventName, payload] = eventData;

            if (eventName === 'output') {
                // Terminal output event
                this.emit('output', payload.data);
            } else if (eventName === 'idle_timeout') {
                logger.info('Server sent idle_timeout');
                this.emit('error', new IdleTimeoutError());
            } else if (eventName === 'connection_failed') {
                logger.info('Server sent connection_failed');
                this.emit('error', new ConnectionFailedError());
            } else if (eventName === 'disconnect') {
                logger.info('Server sent disconnect event');
                this.emit('disconnect');
            } else if (eventName === 'user_count_update') {
                // User count event - validate and emit for runner to check
                if (payload && typeof payload.current_users === 'number' && typeof payload.max_users === 'number') {
                    this.emit('user_count', payload);
                    logger.debug(`User count: ${payload.current_users}/${payload.max_users}`);
                } else {
                    logger.warn('Invalid user_count_update payload:', payload);
                }
            } else if (eventName === 'activity_ping') {
                // Harmless heartbeat - ignore silently
                return;
            } else {
                // Unknown event - log for debugging
                logger.debug(`Unknown event: ${eventName}`);
            }
        } catch (e) {
            logger.error('Failed to parse event:', e.message);
        }
    }

    /**
     * Sends a command input to the remote terminal.
     * @param {string} command - The text to send.
     * @returns {Promise<void>}
     * @throws {Error} If the socket is not connected.
     */
    async sendCommand(command) {
        logger.debug(`📤 Attempting to send command: "${command}"`);

        if (!this.ws) {
            logger.error('❌ WebSocket object is null');
            throw new Error('WebSocket not initialized');
        }

        const state = this.ws.readyState;
        const stateNames = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
        logger.debug(`Connection state: ${stateNames[state]} (${state})`);

        if (!this.connected || state !== WebSocket.OPEN) {
            logger.error(`❌ Cannot send - not connected (state: ${stateNames[state]})`);
            throw new Error('WebSocket not connected');
        }

        const payload = JSON.stringify(['input', { input: command }]);
        logger.debug(`📡 Sending payload: ${payload}`);

        try {
            this.ws.send('42' + payload);
            logger.debug(`✅ Command sent successfully`);
        } catch (err) {
            logger.error(`❌ Failed to send: ${err.message}`);
            throw err;
        }

        // Small delay to prevent flooding
        await new Promise(r => setTimeout(r, WS_COMMAND_DELAY_MS));
    }

    /**
     * Triggers the terminal start sequence via WebSocket.
     * @returns {Promise<void>}
     * @throws {Error} If not connected.
     */
    async startTerminal() {
        if (!this.connected) {
            throw new Error('Must connect before starting terminal');
        }

        logger.info('Sending stop event (cleanup)...');
        const stopPayload = JSON.stringify(['stop', {}]);
        this.ws.send('42' + stopPayload);

        await new Promise(r => setTimeout(r, 500));

        logger.info('Sending start event...');
        const startPayload = JSON.stringify(['start', { args: '' }]);
        this.ws.send('42' + startPayload);
    }

    /**
     * Closes the WebSocket connection cleanly.
     */
    close() {
        logger.info('Closing connection...');
        this._stopPing();
        this.connected = false;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}
