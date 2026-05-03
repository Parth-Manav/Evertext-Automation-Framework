import { RustBrain } from './brain.js';
import { sendLog } from './bot.js';
import { BrowserController } from './browser-controller.js';
import { EvertextWebSocketClient } from './websocket-client.js';
import { config } from './config.js';

// Helper to clean HTML but PRESERVE structure for server selection
const stripHTML = (html) => {
    return html
        .replace(/<br\s*\/?>/gi, '\n') // Convert <br> to newline
        .replace(/<\/div>/gi, '\n')    // Convert </div> to newline
        .replace(/<\/p>/gi, '\n')      // Convert </p> to newline
        .replace(/<[^>]*>/g, '')       // Strip remaining tags
        .trim();
};

export const runSession = async (account, sharedBrowser = null) => {
    let browser = sharedBrowser; // Reuse if provided
    const createdBrowser = !sharedBrowser; // Track if we created it

    try {
        console.log('\n' + '='.repeat(60));
        console.log(`🤖 [Runner] Starting HYBRID session for "${account.name}"`);
        console.log('='.repeat(60));

        // Get session cookie
        const { getCookies } = await import('./db.js');
        const cookies = await getCookies();
        if (!cookies) {
            throw new Error('No session cookie configured. Use /set_cookies command.');
        }

        // 1. Initial Cleanup & Setup
        let terminalBuffer = '';
        let currentUsers = 0;
        let maxUsers = 4;
        let brain = null;
        let wsClient = null;

        // 2. Start Rust brain FIRST (so it's ready)
        console.log('[Runner] Initializing Rust brain...');
        brain = new RustBrain();
        await brain.start();
        console.log('🧠 [Runner] Rust brain initialized');

        // 3. Launch/Check Browser
        if (!browser) {
            browser = new BrowserController();
            await browser.launch(cookies);

            // Check if login required - ensure cleanup on failure
            try {
                if (await browser.isLoginRequired()) {
                    throw new Error('LOGIN_REQUIRED - Cookie expired or invalid');
                }
            } catch (err) {
                // Cleanup WebSocket if it was created
                if (wsClient) {
                    try { wsClient.close(); } catch (e) { }
                }
                throw err; // Re-throw after cleanup
            }
        }

        // 4. Connect WebSocket (Connect BEFORE clicking Start)
        console.log('[Runner] Connecting WebSocket...');

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
                wsClient.on('output', (data) => terminalBuffer += data);
                wsClient.on('user_count', (data) => {
                    currentUsers = data.current_users;
                    maxUsers = data.max_users;
                });
                // Error listener for logging (logic handled in catch)
                wsClient.on('error', (err) => {
                    if (err.message !== 'CONNECTION_FAILED') {
                        console.error('[Runner] WebSocket error:', err.message);
                    }
                });

                await wsClient.connect();
                connected = true;
                console.log('[Runner] WebSocket connected');

            } catch (err) {
                retryCount++;
                if (err.message === 'CONNECTION_FAILED') {
                    // Exponential backoff: 5s, 10s, 20s, 40s, 60s (max)
                    const backoffDelay = Math.min(5000 * Math.pow(2, retryCount - 1), 60000);
                    const remainingTime = Math.floor((CONNECT_TIMEOUT - (Date.now() - startConnect)) / 1000);
                    console.log(`⚠️ [Runner] Connection rejected (Terminal Full). Retry ${retryCount}/${MAX_RETRIES} in ${backoffDelay / 1000}s (${remainingTime}s remaining)`);
                    await sendLog(`⏸️ **${account.name}**: Terminal full - Retry ${retryCount}/${MAX_RETRIES} in ${backoffDelay / 1000}s`, 'info');
                    await new Promise(r => setTimeout(r, backoffDelay));
                } else {
                    // Start retry logic for other connection errors too, but logging differently
                    console.error('[Runner] Connection failed:', err.message);
                    throw err; // For now, throw on non-capacity errors
                }
            }
        }

        if (!connected) {
            throw new Error('Terminal full - Timed out after 10 minutes');
        }
        // -----------------------------------------------------------
        console.log('[Runner] WebSocket connected');

        // 5. Check if terminal is full BEFORE clicking Start
        if (currentUsers >= maxUsers) {
            console.log(`⚠️ [Runner] Terminal is FULL (${currentUsers}/${maxUsers}). Waiting for slot...`);
            await sendLog(`⏸️ **${account.name}**: Terminal full - waiting for slot`, 'info');

            // Wait for a slot to open (event-driven)
            let checkInterval = null; // Track interval for cleanup
            const slotOpened = await new Promise((resolve) => {
                const MAX_WAIT_TIME = config.MAX_WAIT_TIME_MS;
                const startWait = Date.now();

                checkInterval = setInterval(() => {
                    if (currentUsers < maxUsers) {
                        console.log(`✅ [Runner] Slot opened! (${currentUsers}/${maxUsers})`);
                        clearInterval(checkInterval);
                        checkInterval = null;
                        resolve(true);
                    } else if (Date.now() - startWait > MAX_WAIT_TIME) {
                        console.log(`⏱️ [Runner] Max wait time (10 min) reached. Deferring...`);
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
                return { success: false, reason: 'Terminal full', defer: true, browser, createdBrowser };
            }

            await sendLog(`✅ **${account.name}**: Slot opened - proceeding!`, 'success');
        }

        // 6. Click Start Button (Puppeteer) - Start terminal only when ready
        console.log('[Runner] Starting terminal via browser...');
        await browser.clickStart();

        console.log('✅ [Runner] Hybrid setup complete (Brain -> WebSocket -> Browser Start)\n');

        // Wait for initial terminal output to arrive via WebSocket
        console.log('[Runner] Waiting for initial terminal data...');
        await new Promise(r => setTimeout(r, 2000));

        if (terminalBuffer.length === 0) {
            console.log('⚠️ [Runner] No terminal output received. WebSocket might not be working.');
            console.log('⚠️ [Runner] Waiting 3 more seconds...');
            await new Promise(r => setTimeout(r, 3000));
            console.log(`⚠️ [Runner] Buffer after extra wait: ${terminalBuffer.length} chars`);

            // --- RECONNECTION FIX FOR EMPTY BUFFER ---
            if (terminalBuffer.length === 0) {
                console.log('🔄 [Runner] Buffer STILL empty. Connection stale. Reconnecting WebSocket...');

                if (wsClient) {
                    try { wsClient.close(); } catch (e) { }
                }

                wsClient = new EvertextWebSocketClient(cookies);

                // Re-attach listeners
                wsClient.on('output', (data) => {
                    terminalBuffer += data;
                    // Log first chunk only to avoid spam
                    if (terminalBuffer.length < 500) console.log(`[WebSocket] 📥 Re-connected data: ${data.length} chars`);
                });

                wsClient.on('user_count', (data) => {
                    currentUsers = data.current_users;
                    maxUsers = data.max_users;
                });

                wsClient.on('error', (err) => {
                    console.error('[Runner] WebSocket error (Reconnected):', err.message);
                });

                console.log('[Runner] Re-connecting...');
                await wsClient.connect();
                console.log('[Runner] Re-connected! Waiting 2s for data...');
                await new Promise(r => setTimeout(r, config.BROWSER_RECONNECT_WAIT_MS));
                
                if (terminalBuffer.length === 0) {
                     throw new Error('Terminal failed to deliver output after WebSocket reconnect');
                }
            }
            // -----------------------------------------
        } else {
            console.log(`✅ [Runner] Received ${terminalBuffer.length} chars of initial data`);
            console.log(`📊 [Runner] First 150 chars: ${terminalBuffer.substring(0, 150)}`);
        }

        // 6. Main loop starts...

        // 5. Main loop - Process terminal output with brain
        const startTime = Date.now();
        const MAX_SESSION_TIME = config.MAX_SESSION_TIME_MS;
        const IDLE_TIMEOUT_MS = config.IDLE_TIMEOUT_MS;
        let lastProcessedLength = 0;
        let lastDataTime = Date.now();

        console.log('🧠 [Runner] Entering brain-controlled loop...\n');

        while (Date.now() - startTime < MAX_SESSION_TIME) {
            // Check Idle Timeout
            if (Date.now() - lastDataTime > IDLE_TIMEOUT_MS) {
                console.error(`⏱️ [Runner] Idle timeout (${IDLE_TIMEOUT_MS}ms) - No new data.`);
                throw new Error('IDLE_TIMEOUT');
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

            if (cleanText.includes('Which acc u want to Login')) {
                // Server selection: inject history so brain can find the server index.
                console.log('[Runner] 🛠️ Server-selection prompt detected. Injecting history...');
                const startIdx = Math.max(0, fullClean.length - config.SERVER_LIST_CONTEXT_CHARS);
                cleanText = fullClean.slice(startIdx);
                console.log(`[Runner] Target server: ${account.targetServer}`);
            } else if (cleanText.includes('Select the Event [')) {
                // Event selection: inject history so brain can parse the full event list.
                console.log('[Runner] 🗂️ Event-selection prompt detected. Injecting history...');
                // Grab the last 3000 chars - enough to capture all listed events.
                const startIdx = Math.max(0, fullClean.length - 3000);
                cleanText = fullClean.slice(startIdx);
                console.log('[Runner] 🔍 Event list context:');
                console.log(cleanText);
            }
            // -------------------------------------------------

            // Send to brain
            const response = await brain.processTerminalOutput(cleanText, {
                name: account.name,
                code: account.code,
                targetServer: account.targetServer.trim(), // Trim to handle accidental spaces
                serverToggle: account.serverToggle // Pass the toggle
            });

            console.log(`[Brain Decision] Action: ${response.action}`);

            // Execute brain's command
            if (response.action === 'send_text') {
                console.log(`[Runner] ➡️ Sending: "${response.payload}"${response.context ? ` [ctx: ${response.context}]` : ''}`);
                await wsClient.sendCommand(response.payload);

                // ── Contextual Discord logging ──────────────────────────────
                if (response.context === 'server_selection') {
                    // Parse terminal to extract rich server info for the log
                    const lines = terminalBuffer.split('\n');
                    let serverInfo = null;
                    for (const line of lines) {
                        // Pattern: "1--> Server-Shard: 175 (E-15) || Account-Name: Cat Man || Guild: Night Raid"
                        const match = line.match(/^\s*(\d+)-->\s*Server-Shard:\s*(\d+)\s*\(([^)]+)\)\s*\|\|\s*Account-Name:\s*([^|]+)\s*\|\|\s*Guild:\s*(.+)$/);
                        if (match && match[1] === response.payload) {
                            serverInfo = {
                                shard: match[2],
                                server: match[3],
                                accountName: match[4].trim(),
                                guild: match[5].trim()
                            };
                            break;
                        }
                    }
                    if (serverInfo) {
                        await sendLog(
                            `🚀 **${account.name}** starting\n` +
                            `📍 Server-Shard: ${serverInfo.shard} (${serverInfo.server}) || Account: ${serverInfo.accountName} || Guild: ${serverInfo.guild}`,
                            'info'
                        );
                    } else {
                        await sendLog(`🚀 **${account.name}**: Starting (Server index: ${response.payload})`, 'info');
                    }

                } else if (response.context === 'event_selection') {
                    // Log which event the bot chose
                    const lines = terminalBuffer.split('\n');
                    let chosenEvent = null;
                    for (const line of lines) {
                        // Pattern: "-->2. elizabethstrythree | Coins: 0 | Expires: 2 days 14 hours left"
                        const match = line.match(/-->\s*(\d+)\.\s*([^|]+)\|[^|]*\|\s*Expires:\s*(.+)/);
                        if (match && match[1] === response.payload) {
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
                        await sendLog(`🗂️ **${account.name}**: Selected event index **${response.payload}**`, 'info');
                    }
                }

            } else if (response.action === 'close_terminal') {
                console.log(`[Runner] Session complete: ${response.reason}`);

                // Stop terminal via Puppeteer (but don't close browser)
                if (browser && browser.isLaunched()) {
                    await browser.clickStop();
                }

                // Clean up WebSocket and brain
                if (wsClient) wsClient.close();
                if (brain) brain.stop();

                console.log('='.repeat(60) + '\n');
                return { success: true, browser, createdBrowser };

            } else if (response.action === 'restart_terminal') {
                console.log(`[Runner] Restart requested: ${response.reason}`);

                // Stop terminal
                if (browser && browser.isLaunched()) {
                    await browser.clickStop();
                    await new Promise(r => setTimeout(r, 2000));
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
                    console.error('[Runner] WebSocket error:', err.message);
                });
                await wsClient.connect();

                console.log('[Runner] Terminal restarted, continuing...');
                continue;

            } else if (response.action === 'defer_account') {
                console.log(`[Runner] Deferring account: ${response.reason}`);

                if (browser && browser.isLaunched()) {
                    await browser.clickStop();
                }
                if (wsClient) wsClient.close();
                if (brain) brain.stop();

                console.log('='.repeat(60) + '\n');
                return { success: false, reason: response.reason, defer: true, browser, createdBrowser };

            } else if (response.action === 'wait') {
                // Brain is waiting - continue loop
                await new Promise(r => setTimeout(r, 1500));
            }
        }

        // Timeout
        console.log('⚠️ Session timed out (15 minutes)');
        if (browser && browser.isLaunched()) await browser.clickStop();
        if (wsClient) wsClient.close();
        if (brain) brain.stop();
        console.log('='.repeat(60) + '\n');
        return { success: false, reason: 'Session timeout', browser, createdBrowser };

    } catch (error) {
        console.log('\n❌ ERROR OCCURRED');
        console.log('💥 Error:', error.message);
        console.log('='.repeat(60) + '\n');

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
