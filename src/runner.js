/**
 * @module runner
 * @description Orchestrates the hybrid execution pipeline for a single account session.
 * Manages the lifecycle of the browser, WebSocket client, and Rust brain,
 * feeding terminal output to the decision engine and executing its commands.
 */

import { RustBrain } from './brain.js';
import { sendLog } from './bot.js';
import { BrowserController } from './browser-controller.js';
import { EvertextWebSocketClient } from './websocket-client.js';
import { config } from './config.js';
import {
    DEFAULT_MAX_USERS,
    CONNECTION_BACKOFF_BASE_MS,
    CONNECTION_BACKOFF_MAX_MS,
    BROWSER_INITIAL_DATA_WAIT_MS,
    BROWSER_EXTRA_WAIT_MS,
    TERMINAL_RESTART_WAIT_MS,
    BRAIN_WAIT_LOOP_MS,
    TERMINAL_MSG_WHICH_ACC_LOGIN,
    TERMINAL_MSG_SELECT_EVENT,
    EVENT_LIST_CONTEXT_CHARS,
    TERMINAL_PREVIEW_CHARS,
    WS_VERBOSE_OUTPUT_THRESHOLD,
    ERROR_CODE_CONNECTION_FAILED
} from './constants.js';
import { createLogger } from './logger.js';
import {
    SessionExpiredError,
    ServerFullError,
    ZigzaError,
    IdleTimeoutError,
    ValidationError,
    isErrorCode
} from './errors.js';

const logger = createLogger('runner');

/**
 * Helper to clean HTML but PRESERVE structure for server selection.
 * @param {string} html - The raw HTML output from the terminal.
 * @returns {string} The cleaned plain-text string.
 */
const stripHTML = (html) => {
    return html
        .replace(/<br\s*\/?>/gi, '\n') // Convert <br> to newline
        .replace(/<\/div>/gi, '\n')    // Convert </div> to newline
        .replace(/<\/p>/gi, '\n')      // Convert </p> to newline
        .replace(/<[^>]*>/g, '')       // Strip remaining tags
        .trim();
};

/**
 * Runs a full automation session for a given account.
 * @param {import('./types.js').Account} account - The account to run.
 * @param {BrowserController|null} [sharedBrowser=null] - An optional shared browser instance.
 * @returns {Promise<{success: boolean, reason?: string, defer?: boolean, browser: BrowserController|null, createdBrowser: boolean}>} The session result.
 */
export const runSession = async (account, sharedBrowser = null) => {
    let browser = sharedBrowser; // Reuse if provided
    const createdBrowser = !sharedBrowser; // Track if we created it

    // These need to be declared outside the try block for cleanup in catch
    let wsClient = null;
    let brain = null;

    try {
        logger.info('\n' + '='.repeat(60));
        logger.info(`🤖 Starting HYBRID session for "${account.name}"`);
        logger.info('='.repeat(60));

        // Get session cookie
        const { getCookies } = await import('./db.js');
        const cookies = await getCookies();
        if (!cookies) {
            throw new ValidationError('No session cookie configured. Use /set_cookies command.');
        }

        // 1. Initial Cleanup & Setup
        let terminalBuffer = '';
        let currentUsers = 0;
        let maxUsers = DEFAULT_MAX_USERS;

        // 2. Start Rust brain FIRST (so it's ready)
        logger.info('Initializing Rust brain...');
        brain = new RustBrain();
        await brain.start();
        logger.info('🧠 Rust brain initialized');

        // 3. Launch/Check Browser
        if (!browser) {
            browser = new BrowserController();
            await browser.launch(cookies);

            // Check if login required - ensure cleanup on failure
            try {
                if (await browser.isLoginRequired()) {
                    throw new SessionExpiredError('LOGIN_REQUIRED - Cookie expired or invalid');
                }
            } catch (err) {
                if (wsClient) {
                    try { wsClient.close(); } catch (e) { }
                }
                throw err;
            }
        }

        // 4. Connect WebSocket (Connect BEFORE clicking Start)
        logger.info('Connecting WebSocket...');

        // --- Polling Loop for Connection (Retry if Terminal Full) ---
        const CONNECT_TIMEOUT = config.CONNECT_TIMEOUT_MS;
        const startConnect = Date.now();
        let connected = false;
        let retryCount = 0;
        const MAX_RETRIES = 20; // Limit total retries

        while (!connected && (Date.now() - startConnect < CONNECT_TIMEOUT) && retryCount < MAX_RETRIES) {
            try {
                // Create new client instance if needed (clean state)
                if (wsClient) {
                    try { wsClient.close(); } catch (e) { }
                }
                wsClient = new EvertextWebSocketClient(cookies);

                // Re-attach listeners every attempt
                wsClient.on('output', (terminalOutput) => { terminalBuffer += terminalOutput; });
                wsClient.on('user_count', (data) => {
                    currentUsers = data.current_users;
                    maxUsers = data.max_users;
                });
                
                // Error listener for logging (logic handled in catch)
                wsClient.on('error', (wsError) => {
                    if (!isErrorCode(wsError, ERROR_CODE_CONNECTION_FAILED)) {
                        logger.error('WebSocket error:', wsError.message);
                    }
                });

                await wsClient.connect();
                connected = true;
                logger.info('WebSocket connected');

            } catch (err) {
                retryCount++;
                if (isErrorCode(err, ERROR_CODE_CONNECTION_FAILED)) {
                    const backoffDelay = Math.min(
                        CONNECTION_BACKOFF_BASE_MS * Math.pow(2, retryCount - 1),
                        CONNECTION_BACKOFF_MAX_MS
                    );
                    const remainingTime = Math.floor((CONNECT_TIMEOUT - (Date.now() - startConnect)) / 1000);
                    logger.warn(`Connection rejected (Terminal Full). Retry ${retryCount}/${MAX_RETRIES} in ${backoffDelay / 1000}s (${remainingTime}s remaining)`);
                    await sendLog(`⏸️ **${account.name}**: Terminal full - Retry ${retryCount}/${MAX_RETRIES} in ${backoffDelay / 1000}s`, 'warning');
                    await new Promise(r => setTimeout(r, backoffDelay));
                } else {
                    // Start retry logic for other connection errors too, but logging differently
                    logger.error('Connection failed:', err.message);
                    throw err; // For now, throw on non-capacity errors
                }
            }
        }

        if (!connected) {
            throw new ServerFullError('Terminal full - Timed out after 10 minutes');
        }
        // -----------------------------------------------------------

        // 5. Check if terminal is full BEFORE clicking Start
        if (currentUsers >= maxUsers) {
            logger.warn(`Terminal is FULL (${currentUsers}/${maxUsers}). Waiting for slot...`);
            await sendLog(`⏸️ **${account.name}**: Terminal full - waiting for slot`, 'warning');

            // Wait for a slot to open (event-driven)
            let checkInterval = null; // Track interval for cleanup
            const slotOpened = await new Promise((resolve) => {
                const MAX_WAIT_TIME = config.MAX_WAIT_TIME_MS;
                const startWait = Date.now();

                checkInterval = setInterval(() => {
                    if (currentUsers < maxUsers) {
                        logger.info(`✅ Slot opened! (${currentUsers}/${maxUsers})`);
                        clearInterval(checkInterval);
                        checkInterval = null;
                        resolve(true);
                    } else if (Date.now() - startWait > MAX_WAIT_TIME) {
                        logger.warn(`⏱️ Max wait time (10 min) reached. Deferring...`);
                        clearInterval(checkInterval);
                        checkInterval = null;
                        resolve(false);
                    }
                }, config.SLOT_CHECK_INTERVAL_MS);

                // Cleanup interval if WebSocket disconnects
                const cleanupInterval = () => {
                    if (checkInterval) {
                        clearInterval(checkInterval);
                        checkInterval = null;
                        resolve(false);
                    }
                };

                wsClient.once('disconnect', cleanupInterval);
                wsClient.once('error', cleanupInterval);
            });

            if (!slotOpened) {
                await sendLog(`⏭️ **${account.name}**: Terminal full after 10 min - deferring`, 'info');
                if (wsClient) wsClient.close();
                if (brain) brain.stop();
                return {
                    success: false,
                    reason: 'Terminal full',
                    defer: true,
                    error: new ZigzaError('Terminal full'),
                    browser,
                    createdBrowser
                };
            }

            await sendLog(`✅ **${account.name}**: Slot opened - proceeding!`, 'success');
        }

        // 6. Click Start Button (Puppeteer) - Start terminal only when ready
        logger.info('Starting terminal via browser...');
        await browser.clickStart();

        logger.info('✅ Hybrid setup complete (Brain -> WebSocket -> Browser Start)\n');

        // Wait for initial terminal output to arrive via WebSocket
        logger.info('Waiting for initial terminal data...');
        await new Promise(r => setTimeout(r, config.BROWSER_INITIAL_DATA_WAIT_MS));

        if (terminalBuffer.length === 0) {
            logger.warn('No terminal output received. WebSocket might not be working.');
            logger.warn('Waiting for additional terminal data...');
            await new Promise(r => setTimeout(r, config.BROWSER_EXTRA_WAIT_MS));
            logger.warn(`Buffer after extra wait: ${terminalBuffer.length} chars`);

            // --- RECONNECTION FIX FOR EMPTY BUFFER ---
            if (terminalBuffer.length === 0) {
                logger.info('🔄 Buffer STILL empty. Connection stale. Reconnecting WebSocket...');

                if (wsClient) {
                    try { wsClient.close(); } catch (e) { }
                }

                wsClient = new EvertextWebSocketClient(cookies);

                // Re-attach listeners
                wsClient.on('output', (terminalOutput) => {
                    terminalBuffer += terminalOutput;
                    if (terminalBuffer.length < WS_VERBOSE_OUTPUT_THRESHOLD) {
                        logger.info(`[WebSocket] 📥 Re-connected data: ${terminalOutput.length} chars`);
                    }
                });

                wsClient.on('user_count', (data) => {
                    currentUsers = data.current_users;
                    maxUsers = data.max_users;
                });

                wsClient.on('error', (err) => {
                    logger.error('WebSocket error (Reconnected):', err.message);
                });

                logger.info('Re-connecting...');
                await wsClient.connect();
                logger.info('Re-connected! Waiting 2s for data...');
                await new Promise(r => setTimeout(r, config.BROWSER_RECONNECT_WAIT_MS));
                
                if (terminalBuffer.length === 0) {
                     throw new Error('Terminal failed to deliver output after WebSocket reconnect');
                }
            }
            // -----------------------------------------
        } else {
            logger.info(`✅ Received ${terminalBuffer.length} chars of initial data`);
            logger.debug(`First ${TERMINAL_PREVIEW_CHARS} chars: ${terminalBuffer.substring(0, TERMINAL_PREVIEW_CHARS)}`);
        }

        // 5. Main loop - Process terminal output with brain
        const startTime = Date.now();
        const MAX_SESSION_TIME = config.MAX_SESSION_TIME_MS;
        const IDLE_TIMEOUT_MS = config.IDLE_TIMEOUT_MS;
        let lastProcessedLength = 0;
        let lastDataTime = Date.now();

        logger.info('🧠 Entering brain-controlled loop...\n');

        while (Date.now() - startTime < MAX_SESSION_TIME) {
            // Check Idle Timeout
            if (Date.now() - lastDataTime > IDLE_TIMEOUT_MS) {
                logger.error(`⏱️ Idle timeout (${IDLE_TIMEOUT_MS}ms) - No new data.`);
                throw new IdleTimeoutError();
            }

            // Extract new text from buffer
            let newText = '';
            if (terminalBuffer.length > lastProcessedLength) {
                newText = terminalBuffer.slice(lastProcessedLength);
                lastProcessedLength = terminalBuffer.length;
                lastDataTime = Date.now(); // Reset idle timer on new data
            }

            // --- HTML Stripping Fix ---
            let cleanText = stripHTML(newText);
            // ---------------------------

            // --- Context Injection ---
            // For any prompt that requires reading earlier output (server list, event list),
            // we inject a slice of the full cleaned buffer so the brain has full context.
            const fullClean = stripHTML(terminalBuffer);

            if (cleanText.includes(TERMINAL_MSG_WHICH_ACC_LOGIN)) {
                // Server selection: inject history so brain can find the server index.
                logger.info('🛠️ Server-selection prompt detected. Injecting history...');
                const startIdx = Math.max(0, fullClean.length - config.SERVER_LIST_CONTEXT_CHARS);
                cleanText = fullClean.slice(startIdx);
                logger.info(`Target server: ${account.targetServer}`);
            } else if (cleanText.includes(TERMINAL_MSG_SELECT_EVENT)) {
                // Event selection: inject history so brain can parse the full event list.
                logger.info('🗂️ Event-selection prompt detected. Injecting history...');
                const startIdx = Math.max(0, fullClean.length - EVENT_LIST_CONTEXT_CHARS);
                cleanText = fullClean.slice(startIdx);
                logger.debug('Event list context provided to brain.');
            }
            // -------------------------------------------------

            // Send to brain
            const brainResponse = await brain.processTerminalOutput(cleanText, {
                name: account.name,
                code: account.code,
                targetServer: account.targetServer.trim(), // Trim to handle accidental spaces
                serverToggle: account.serverToggle // Pass the toggle
            });

            logger.info(`[Brain Decision] Action: ${brainResponse.action}`);

            // Execute brain command (maps to Rust BotState transitions)
            if (brainResponse.action === 'send_text') {
                logger.info(`➡️ Sending: "${brainResponse.payload}"${brainResponse.context ? ` [ctx: ${brainResponse.context}]` : ''}`);
                await wsClient.sendCommand(brainResponse.payload);

                // ── Contextual Discord logging ──────────────────────────────
                if (brainResponse.context === 'server_selection') {
                    // Parse terminal to extract rich server info for the log
                    const lines = terminalBuffer.split('\n');
                    let serverInfo = null;
                    for (const line of lines) {
                        // Pattern: "1--> Server-Shard: 175 (E-15)" OR "7--> Server: E-16 (176) || Account: Destiny || Guild: Fake RDC"
                        const match = line.match(/^\s*(\d+)-->\s*(?:Server-Shard|Server):\s*([^|]+)\s*\|\|\s*Account(?:-Name)?:\s*([^|]+)\s*\|\|\s*Guild:\s*(.+)$/i);
                        if (match && match[1] === brainResponse.payload) {
                            serverInfo = {
                                server: match[2].trim(),
                                accountName: match[3].trim(),
                                guild: match[4].trim()
                            };
                            break;
                        }
                    }
                    if (serverInfo) {
                        await sendLog(
                            `🚀 **${account.name}** starting\n` +
                            `📍 Server: ${serverInfo.server} || Account: ${serverInfo.accountName} || Guild: ${serverInfo.guild}`,
                            'info'
                        );
                    } else {
                        await sendLog(`🚀 **${account.name}**: Starting (Server index: ${brainResponse.payload})`, 'info');
                    }

                } else if (brainResponse.context === 'event_selection') {
                    // Log which event the bot chose
                    const lines = terminalBuffer.split('\n');
                    let chosenEvent = null;
                    for (const line of lines) {
                        // Pattern: "-->2. elizabethstrythree | Coins: 0 | Expires: 2 days 14 hours left"
                        const match = line.match(/-->\s*(\d+)\.\s*([^|]+)\|[^|]*\|\s*Expires:\s*(.+)/);
                        if (match && match[1] === brainResponse.payload) {
                            chosenEvent = { name: match[2].trim(), expires: match[3].trim() };
                            break;
                        }
                    }
                    if (chosenEvent) {
                        await sendLog(
                            `🗂️ **${account.name}**: Selected event **${chosenEvent.name}** (Expires: ${chosenEvent.expires})`,
                            'info'
                        );
                    } else {
                        await sendLog(`🗂️ **${account.name}**: Selected event index **${brainResponse.payload}**`, 'info');
                    }
                }

            } else if (brainResponse.action === 'close_terminal') {
                logger.info(`Session complete: ${brainResponse.reason}`);

                // Stop terminal via Puppeteer (but don't close browser)
                if (browser && browser.isLaunched()) {
                    await browser.clickStop();
                }

                // Clean up WebSocket and brain
                if (wsClient) wsClient.close();
                if (brain) brain.stop();

                logger.info('='.repeat(60) + '\n');
                return { success: true, browser, createdBrowser };

            } else if (brainResponse.action === 'restart_terminal') {
                logger.info(`Restart requested: ${brainResponse.reason}`);

                // Stop terminal
                if (browser && browser.isLaunched()) {
                    await browser.clickStop();
                    await new Promise(r => setTimeout(r, TERMINAL_RESTART_WAIT_MS));
                }

                // Close old WebSocket completely
                if (wsClient) {
                    wsClient.close();
                    wsClient = null;
                }

                // Reset brain state
                await brain.sendMessage({ type: 'init' });

                // Restart terminal
                if (browser && browser.isLaunched()) {
                    await browser.clickStart();
                }

                // Create new WebSocket
                terminalBuffer = '';
                lastProcessedLength = 0;

                wsClient = new EvertextWebSocketClient(cookies);
                wsClient.on('output', (data) => {
                    terminalBuffer += data;
                });
                wsClient.on('error', (err) => {
                    logger.error('WebSocket error:', err.message);
                });
                await wsClient.connect();

                logger.info('Terminal restarted, continuing...');
                continue;

            } else if (brainResponse.action === 'defer_account') {
                logger.info(`Deferring account: ${brainResponse.reason}`);

                if (browser && browser.isLaunched()) {
                    await browser.clickStop();
                }
                if (wsClient) wsClient.close();
                if (brain) brain.stop();

                logger.info('='.repeat(60) + '\n');
                return {
                    success: false,
                    reason: brainResponse.reason,
                    defer: true,
                    error: new ZigzaError(brainResponse.reason),
                    browser,
                    createdBrowser
                };

            } else if (brainResponse.action === 'wait') {
                // Brain is waiting for more terminal output — continue polling loop
                await new Promise(r => setTimeout(r, BRAIN_WAIT_LOOP_MS));
            }
        }

        // Timeout
        logger.warn('⚠️ Session timed out (15 minutes)');
        if (browser && browser.isLaunched()) await browser.clickStop();
        if (wsClient) wsClient.close();
        if (brain) brain.stop();
        logger.info('='.repeat(60) + '\n');
        return { success: false, reason: 'Session timeout', browser, createdBrowser };

    } catch (error) {
        logger.error('\n❌ ERROR OCCURRED');
        logger.error('💥 Error:', error.message);
        logger.info('='.repeat(60) + '\n');

        // Clean up carefully
        try {
            if (wsClient) wsClient.close();
        } catch (e) { /* ignore */ }

        try {
            if (brain) brain.stop();
        } catch (e) { /* ignore */ }

        try {
            if (browser && browser.isLaunched()) await browser.clickStop();
        } catch (e) { /* ignore */ }

        return { success: false, reason: error.message, browser, createdBrowser };
    }
};
