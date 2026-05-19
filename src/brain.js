/**
 * @module brain
 * @description Node.js wrapper for the Rust-based state machine.
 * Manages the lifecycle of the Rust child process and facilitates
 * bidirectional IPC (Inter-Process Communication) using JSON over stdin/stdout.
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createLogger } from './logger.js';
import { BRAIN_RESPONSE_TIMEOUT_MS, BRAIN_SHUTDOWN_GRACE_MS } from './constants.js';
import { BrainCommunicationError, ValidationError } from './errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logger = createLogger('brain');

/**
 * Controller class for the Rust decision engine process.
 */
export class RustBrain {
    constructor() {
        /** @type {import('child_process').ChildProcess | null} */
        this.process = null;
        /** @type {boolean} */
        this.ready = false;
        /** @type {Array<Function>} */
        this.responseHandlers = [];
    }

    /**
     * Spawns the Rust child process and establishes IPC channels.
     * @returns {Promise<void>} Resolves when the brain sends the "ready" signal.
     * @throws {Error} If the process fails to start.
     */
    async start() {
        return new Promise((resolve, reject) => {
            // Platform-aware executable name
            const exeName = process.platform === 'win32' ? 'evertext_brain.exe' : 'evertext_brain';

            // Resolve path relative to current executable
            let brainPath = path.join(__dirname, '../evertext_brain/target/release', exeName);

            logger.info('Resolving Rust brain path...');
            logger.debug('Candidate 1 (Source relative):', brainPath);
            logger.info('Starting Rust brain:', brainPath);

            this.process = spawn(brainPath, [], {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            this.process.on('error', (err) => {
                logger.error('Failed to start:', err);
                reject(err);
            });

            this.process.stdout.on('data', (data) => {
                const text = data.toString();

                const lines = text.split('\n').filter(l => l.trim());
                for (const line of lines) {
                    try {
                        const response = JSON.parse(line);

                        // Don't log keep-alives or noisy events
                        if (response.action !== 'heartbeat') {
                            const logResponse = { ...response };
                            if (logResponse.payload && logResponse.payload.length > 100) {
                                logResponse.payload = `[TRUNCATED] ${logResponse.payload.substring(0, 50)}...`;
                            }
                            logger.info('Response:', logResponse);
                        }

                        if (response.action === 'ready') {
                            this.ready = true;
                            resolve();
                        }

                        // Call the pending handler if exists
                        if (this.responseHandlers.length > 0) {
                            const handler = this.responseHandlers.shift();
                            handler(response);
                        }
                    } catch (e) {
                        // Common issue: Rust panic or non-JSON output
                        if (line.includes('panic')) {
                            logger.error('CRITICAL: RUST PANIC DETECTED ->', line);
                        } else {
                            logger.warn('Skipped non-JSON output:', line.substring(0, 100));
                        }
                    }
                }
            });

            this.process.stderr.on('data', (data) => {
                logger.error('Stderr:', data.toString());
            });

            this.process.on('exit', (code) => {
                logger.info('Process exited with code:', code);
                this.ready = false;
                // Clear all pending handlers
                while (this.responseHandlers.length > 0) {
                    const handler = this.responseHandlers.shift();
                    handler({ action: 'error', message: 'Brain process died' });
                }
            });

            // Send init message
            this.sendMessage({ type: 'init' });
        });
    }

    /**
     * Sends a JSON message to the Rust process via stdin.
     * @param {Object} msg - The message object to serialize and send.
     * @throws {BrainCommunicationError} If the process is not running.
     */
    sendMessage(msg) {
        if (!this.process) {
            throw new BrainCommunicationError('Brain process not started');
        }
        if (!msg || typeof msg !== 'object' || !msg.type) {
            throw new ValidationError('IPC message must be an object with a type field');
        }

        const logMsg = { ...msg };
        if (logMsg.content && logMsg.content.length > 100) {
            logMsg.content = `[TRUNCATED] (${logMsg.content.length} chars) - ${logMsg.content.substring(0, 50)}...`;
        }
        logger.debug('Sending:', JSON.stringify(logMsg));

        const json = JSON.stringify(msg);
        this.process.stdin.write(json + '\n');
    }

    /**
     * Sends a message and waits for a response from the Rust process.
     * @param {Object} msg - The message to send.
     * @param {number} [timeoutMs] - Max time to wait for a response (default: BRAIN_RESPONSE_TIMEOUT_MS).
     * @returns {Promise<import('./types.js').BrainResponse>} The decided action payload.
     * @throws {BrainCommunicationError} If the response times out.
     */
    async sendAndWait(msg, timeoutMs = BRAIN_RESPONSE_TIMEOUT_MS) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                // Remove handler from queue
                const index = this.responseHandlers.indexOf(resolve);
                if (index > -1) {
                    this.responseHandlers.splice(index, 1);
                }
                reject(new BrainCommunicationError('Brain response timeout'));
            }, timeoutMs);

            const wrappedResolve = (response) => {
                clearTimeout(timeout);
                resolve(response);
            };

            this.responseHandlers.push(wrappedResolve);
            this.sendMessage(msg);
        });
    }

    /**
     * Helper to process terminal output within a specific account context.
     * @param {string} content - The raw terminal string.
     * @param {import('./types.js').Account} account - The account context.
     * @returns {Promise<import('./types.js').BrainResponse>} The brain's response.
     */
    async processTerminalOutput(content, account) {
        if (typeof content !== 'string') {
            throw new ValidationError('Terminal content must be a string');
        }
        if (!account?.code) {
            throw new ValidationError('Account context must include a restore code');
        }

        const response = await this.sendAndWait({
            type: 'terminal_output',
            content,
            account: {
                name: account.name,
                code: account.code,
                targetServer: account.targetServer,
                server_toggle: account.serverToggle // Send as snake_case for Rust
            }
        });
        return response;
    }

    /**
     * Gracefully stops the Rust process.
     * @returns {Promise<void>}
     */
    async stop() {
        if (this.process) {
            logger.info('Stopping brain process...');

            // Send SIGTERM for graceful shutdown
            this.process.kill('SIGTERM');

            // Wait for exit event with timeout
            await new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    logger.warn('Process did not exit gracefully, forcing kill');
                    if (this.process) {
                        this.process.kill('SIGKILL');
                    }
                    resolve();
                }, BRAIN_SHUTDOWN_GRACE_MS);

                if (this.process) {
                    this.process.once('exit', () => {
                        clearTimeout(timeout);
                        resolve();
                    });
                }
            });

            this.process = null;
            this.ready = false;
        }
    }
}
