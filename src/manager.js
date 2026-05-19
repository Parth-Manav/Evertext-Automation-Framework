/**
 * @module manager
 * @description Core orchestration engine for scheduling and executing automation sessions.
 * Handles queue management, the daily reset cycle, concurrent session locking,
 * and advanced retry/defer logic for rate limits.
 */

import cron from 'node-cron';
import { getAccounts, updateAccountStatus, getAccountDecrypted, resetAllStatuses } from './db.js';
import { runSession } from './runner.js';
import { sendLog } from './bot.js';
import { AsyncLock } from './async-lock.js';
import { config } from './config.js';
import { updateActivity } from './health-server.js';
import { rotateLogs } from './log-rotator.js';
import { createLogger } from './logger.js';
import { ZIGZA_DEFER_DELAY_MS, ACCOUNT_STATUS } from './constants.js';

const logger = createLogger('manager');
const lock = new AsyncLock(); // Prevent race conditions
let isRunning = false;

/**
 * Kill-switch flag. When set to true, the currently running queue will safely
 * terminate after the active account finishes processing.
 * @type {boolean}
 */
let shouldStop = false; 

/**
 * Tracks the timestamp when an account was deferred due to Zigza rate limits.
 * The system enforces a 10-minute wait before retrying these accounts.
 * @type {Map<string, number>}
 */
const deferredAccounts = new Map();

/**
 * Tracks how many times an account has entered a defer cycle.
 * @type {Map<string, number>}
 */
const deferCycles = new Map();

/**
 * Activates the kill-switch, signaling the queue processor to stop accepting
 * new accounts and exit cleanly after the current session.
 */
export const forceStop = () => {
    logger.warn('🛑 FORCE STOP activated');
    shouldStop = true;
};

/**
 * Initializes the automated scheduling system.
 * Sets up the cron job for daily resets and triggers an immediate queue check.
 */
export const startScheduler = () => {
    logger.info('Scheduler started.');
    const now = new Date();
    logger.info(`Current system time: ${now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`);
    logger.info(`Next daily reset scheduled for: 00:00 IST (Asia/Kolkata timezone)`);

    // Clean old logs on startup
    rotateLogs().catch(err => logger.error('Log rotation error:', err));

    // Daily reset check every minute to prevent drift downtime (Asia/Kolkata timezone)
    cron.schedule('* * * * *', async () => {
        const { getLastResetDate, setLastResetDate } = await import('./db.js');
        const nowInIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
        const todayStr = nowInIST.toISOString().split('T')[0]; // YYYY-MM-DD in IST
        
        const lastReset = await getLastResetDate();
        if (!lastReset || new Date(todayStr) > new Date(lastReset)) {
            logger.info(`📅 Daily reset triggered for ${todayStr} IST (Previous: ${lastReset})`);
            
            await resetAllStatuses();
            await setLastResetDate(todayStr);

            deferredAccounts.clear(); // Clear defer timestamps
            deferCycles.clear(); // Clear defer cycle counts
            sendLog('🔄 **Daily Reset**: All accounts reset to pending status', 'info');

            // Start processing queue automatically
            await processQueueFull();
        }
    }, {
        timezone: 'Asia/Kolkata'
    });

    // Check queue immediately on startup
    logger.info('Checking queue on startup...');
    processQueueFull().catch(err => logger.error('Startup queue error:', err));
};

/**
 * Main execution loop for processing the queue of idle/pending accounts.
 * Implements intelligent retries, Zigza defer handling, and browser instance reuse.
 * @returns {Promise<void>}
 */
const processQueueFull = async () => {
    // Acquire lock to prevent race condition
    await lock.acquire();

    if (isRunning) {
        logger.info('Queue already running');
        lock.release();
        return;
    }

    isRunning = true;
    lock.release(); // Release lock after setting flag
    shouldStop = false;
    let sharedBrowser = null;
    const retryCounts = new Map(); // Track retries per account
    const MAX_RETRY_ATTEMPTS = config.MAX_RETRY_ATTEMPTS;

    try {
        const accounts = await getAccounts();
        const pendingAccounts = accounts.filter(a => a.status === ACCOUNT_STATUS.IDLE || a.status === ACCOUNT_STATUS.PENDING);

        if (pendingAccounts.length === 0) {
            logger.info('No pending accounts');
            isRunning = false;
            return;
        }

        logger.info(`Processing ${pendingAccounts.length} accounts...`);
        await sendLog(`▶️ **Queue Started**: Processing ${pendingAccounts.length} accounts`, 'info');

        for (let i = 0; i < pendingAccounts.length; i++) {
            // Check kill-switch
            if (shouldStop) {
                logger.warn('🛑 Kill-switch activated - stopping queue');
                await sendLog('🛑 **Queue Stopped**: Force stop activated', 'error');
                break;
            }

            const account = pendingAccounts[i];

            // --- 10-Minute Zigza Defer Mechanism ---
            // If an account hit a rate limit (Zigza error), it's placed in 'deferredAccounts'.
            // We calculate elapsed time and skip the account if 10 minutes haven't passed.
            // The account remains in the queue (or is pushed back to the end) to be retried later.
            if (deferredAccounts.has(account.id)) {
                const deferredTime = deferredAccounts.get(account.id);
                const elapsedMinutes = (Date.now() - deferredTime) / 60000;

                if (elapsedMinutes < (ZIGZA_DEFER_DELAY_MS / 60000)) {
                    logger.info(`⏭️  Skipping ${account.name} - deferred (${Math.floor((ZIGZA_DEFER_DELAY_MS / 60000) - elapsedMinutes)} min remaining)`);
                    continue; // Skip this account for now
                } else {
                    // 10 minutes passed, can retry
                    logger.info(`✅ Retrying ${account.name} - defer wait complete`);
                    deferredAccounts.delete(account.id);
                }
            }

            try {
                logger.info(`\n[${i + 1}/${pendingAccounts.length}] Processing ${account.name}...`);
                await updateAccountStatus(account.id, ACCOUNT_STATUS.RUNNING);

                // Run session - pass shared browser
                updateActivity();
                const result = await runSession(await getAccountDecrypted(account.id), sharedBrowser);

                if (result.success) {
                    logger.info(`✅ ${account.name} completed successfully`);
                    await updateAccountStatus(account.id, ACCOUNT_STATUS.DONE, new Date().toISOString());
                    await sendLog(`✅ **${account.name}**: Session completed successfully`, 'success');

                    // Update shared browser reference
                    sharedBrowser = result.browser;

                } else if (result.defer) {
                    const attempts = (retryCounts.get(account.id) || 0) + 1;
                    retryCounts.set(account.id, attempts);

                    // Track defer cycles
                    const cycles = (deferCycles.get(account.id) || 0) + 1;
                    deferCycles.set(account.id, cycles);

                    if (attempts <= MAX_RETRY_ATTEMPTS && cycles <= config.MAX_DEFER_CYCLES) {
                        logger.warn(`⏭️  ${account.name} deferred (Zigza error) - Attempt ${attempts}/3, Cycle ${cycles}/3`);
                        await updateAccountStatus(account.id, ACCOUNT_STATUS.DEFERRED);
                        await sendLog(`⚠️ **${account.name}**: Deferred (Zigza) - Attempt ${attempts}/3, Cycle ${cycles}/3`, 'warning');

                        // Mark defer timestamp
                        deferredAccounts.set(account.id, Date.now());
                        // Add to end of queue
                        pendingAccounts.push(account);

                        sharedBrowser = result.browser;
                    } else {
                        logger.error(`❌ ${account.name} failed: Max Zigza retries or defer cycles reached`);
                        await updateAccountStatus(account.id, ACCOUNT_STATUS.ERROR);
                        await sendLog(`❌ **${account.name}**: Failed - Max retries/cycles reached`, 'error');
                        sharedBrowser = result.browser;
                    }

                } else {
                    // Normal Failure - THROW into Catch block for Retries!
                    sharedBrowser = result.browser;
                    throw new Error(result.reason || "Unknown Session Error");
                }

            } catch (err) {
                const attempts = (retryCounts.get(account.id) || 0) + 1;
                retryCounts.set(account.id, attempts);

                // Check if we should retry
                if (attempts <= MAX_RETRY_ATTEMPTS) {
                    logger.warn(`⚠️ Error for ${account.name} (Attempt ${attempts}/${MAX_RETRY_ATTEMPTS}). Retrying...`);
                    await sendLog(`🔄 **${account.name}**: Error (${err.message}) - Retry ${attempts}/3`, 'warning');

                    // Restart browser ONLY if NOT a timeout/login error (as per user request)
                    // If it's a crash or unknown error, we restart. If it's just timeout, we keep browser.
                    const isTimeoutError = err.message === 'IDLE_TIMEOUT' || err.message === 'LOGIN_REQUIRED';

                    if (!isTimeoutError && sharedBrowser) {
                        try { await sharedBrowser.close(); } catch (e) { }
                        sharedBrowser = null;
                        logger.info('Browser restarted due to critical error.');
                    } else if (isTimeoutError) {
                        logger.info('Timeout error: Retrying without browser restart.');
                    }

                    // Retry immediately
                    i--;
                    continue;
                }

                // If max retries reached:
                logger.error(`❌ ${account.name} failed after ${MAX_RETRY_ATTEMPTS} attempts:`, err);
                await updateAccountStatus(account.id, ACCOUNT_STATUS.ERROR);
                await sendLog(`❌ **${account.name}**: Failed - Max retries reached (${err.message})`, 'error');

                // Still close browser to leave clean state for NEXT account
                if (sharedBrowser) {
                    try { await sharedBrowser.close(); } catch (e) { }
                    sharedBrowser = null;
                }
            }

            // Wait between accounts
            if (i < pendingAccounts.length - 1 && !shouldStop) {
                logger.info(`Waiting ${config.ACCOUNT_DELAY_MS / 1000} seconds before next ID...`);
                await new Promise(r => setTimeout(r, config.ACCOUNT_DELAY_MS));

                // Stop terminal from previous ID and start fresh for next ID
                if (sharedBrowser && sharedBrowser.isLaunched()) {
                    try {
                        logger.info('Stopping previous terminal process...');
                        await sharedBrowser.clickStop();

                        // CRITICAL: Wait for process to fully terminate
                        logger.info('Waiting for terminal process to stop...');
                        await new Promise(r => setTimeout(r, 5000)); // 5 seconds for process cleanup

                        logger.info('Ready for next ID (runner will handle start)...');
                    } catch (e) {
                        logger.warn('Cleanup failed (non-critical):', e.message);
                        // Browser might have died, next account will create new one
                        sharedBrowser = null;
                    }
                }
            }
        }

        // Close browser after all IDs done
        if (sharedBrowser && sharedBrowser.isLaunched()) {
            logger.info('All IDs processed - closing browser');
            await sharedBrowser.close();
        }

        logger.info('✅ Queue processing complete');
        await sendLog('✅ **Queue Complete**: All accounts processed', 'success');

    } catch (err) {
        logger.error('Queue error:', err);
        await sendLog(`❌ **Queue Error**: ${err.message}`, 'error');

        // Make sure browser is closed on error
        if (sharedBrowser && sharedBrowser.isLaunched()) {
            try {
                await sharedBrowser.close();
            } catch (e) { /* ignore */ }
        }
    } finally {
        isRunning = false;
        shouldStop = false;
    }
};

/**
 * Triggers a manual full run of all pending accounts.
 * @param {Array<Object>} accounts - List of accounts (unused in current implementation, relies on DB).
 * @returns {Promise<void>}
 */
export const runBatch = async (accounts) => {
    return processQueueFull();
};

/**
 * Executes a session for a single specific account, ignoring the queue.
 * @param {string} accountId - The ID of the account to run.
 * @returns {Promise<{success: boolean, message?: string}>}
 */
export const executeSession = async (accountId) => {
    const release = await lock.acquire();
    if (isRunning) {
        release();
        return { success: false, message: 'Bot is already running a queue' };
    }

    isRunning = true;
    release();
    let browser = null;

    try {
        const account = await getAccountDecrypted(accountId);
        if (!account) {
            return { success: false, message: 'Account not found' };
        }

        logger.info(`Running single account: ${account.name}`);
        await updateAccountStatus(account.id, ACCOUNT_STATUS.RUNNING);

        const result = await runSession(account, null);
        browser = result.browser;

        if (result.success) {
            await updateAccountStatus(account.id, ACCOUNT_STATUS.DONE, new Date().toISOString());
            await sendLog(`✅ **${account.name}**: Session completed successfully`, 'success');
            return { success: true };
        } else {
            await updateAccountStatus(account.id, ACCOUNT_STATUS.ERROR);
            await sendLog(`❌ **${account.name}**: Failed - ${result.reason}`, 'error');
            return { success: false, message: result.reason };
        }

    } catch (err) {
        logger.error('Error:', err);
        return { success: false, message: err.message };
    } finally {
        // Close browser for single runs
        if (browser && browser.isLaunched()) {
            try {
                await browser.close();
            } catch (e) { /* ignore */ }
        }
        isRunning = false;
    }
};

// ==== FOUNTAIN EXECUTION FUNCTIONS ====

/**
 * Executes the fountain collection mini-session for a single account.
 * @param {string} accountId - The ID of the account.
 * @returns {Promise<{success: boolean, message?: string}>}
 */
export const executeFountain = async (accountId) => {
    const release = await lock.acquire();
    if (isRunning) {
        release();
        return { success: false, message: 'Bot is already running a queue' };
    }

    isRunning = true;
    release();
    let browser = null;

    try {
        const account = await getAccountDecrypted(accountId);
        if (!account) {
            return { success: false, message: 'Account not found' };
        }

        logger.info(`Running fountain for account: ${account.name}`);
        await updateAccountStatus(account.id, ACCOUNT_STATUS.RUNNING);

        // Pass mode: 'fountain' to runSession
        const result = await runSession(account, null, 'fountain');
        browser = result.browser;

        if (result.success) {
            await updateAccountStatus(account.id, ACCOUNT_STATUS.DONE, new Date().toISOString());
            await sendLog(`🌊 **${account.name}**: Fountain collected successfully`, 'success');
            return { success: true };
        } else {
            await updateAccountStatus(account.id, ACCOUNT_STATUS.ERROR);
            await sendLog(`❌ **${account.name}**: Fountain failed - ${result.reason}`, 'error');
            return { success: false, message: result.reason };
        }

    } catch (err) {
        logger.error('Fountain error:', err);
        return { success: false, message: err.message };
    } finally {
        // Close browser for single runs
        if (browser && browser.isLaunched()) {
            try {
                await browser.close();
            } catch (e) { /* ignore */ }
        }
        isRunning = false;
    }
};

/**
 * Runs the fountain collection mini-session for all accounts sequentially.
 * @returns {Promise<{completed: number, message?: string, success?: boolean}>}
 */
export const runFountainBatch = async () => {
    if (isRunning) {
        return { success: false, message: 'Bot is already running' };
    }

    const release = await lock.acquire();
    isRunning = true;

    let completedCount = 0;
    let sharedBrowser = null;

    try {
        const accounts = await getAccounts();
        if (accounts.length === 0) {
            logger.info('No accounts to process');
            isRunning = false;
            release();
            return { completed: 0 };
        }

        logger.info(`Starting fountain batch for ${accounts.length} accounts`);
        await sendLog(`🌊 **Fountain Batch Started**: Processing ${accounts.length} accounts`, 'info');

        for (let i = 0; i < accounts.length; i++) {
            if (shouldStop) {
                logger.warn('🛑 Kill-switch activated - stopping fountain batch');
                await sendLog('🛑 **Fountain Batch Stopped**: Force stop activated', 'error');
                break;
            }

            const account = accounts[i];
            try {
                logger.info(`\n[${i + 1}/${accounts.length}] Fountain for ${account.name}...`);
                await updateAccountStatus(account.id, ACCOUNT_STATUS.RUNNING);

                // Run fountain session with shared browser and mode
                const result = await runSession(await getAccountDecrypted(account.id), sharedBrowser, 'fountain');

                // Update shared browser reference
                if (result.createdBrowser) {
                    sharedBrowser = result.browser;
                }

                if (result.success) {
                    logger.info(`✅ Fountain completed for ${account.name}`);
                    await updateAccountStatus(account.id, ACCOUNT_STATUS.DONE, new Date().toISOString());
                    completedCount++;
                } else {
                    logger.error(`❌ Fountain failed for ${account.name}: ${result.reason}`);
                    await updateAccountStatus(account.id, ACCOUNT_STATUS.ERROR);
                }

            } catch (err) {
                logger.error(`Error processing fountain for ${account.name}:`, err);
                await updateAccountStatus(account.id, ACCOUNT_STATUS.ERROR);
            }
        }

        await sendLog(`✅ **Fountain Batch Complete**: Processed ${completedCount}/${accounts.length} accounts`, 'success');
        return { completed: completedCount };

    } catch (err) {
        logger.error('Fountain batch error:', err);
        throw err;
    } finally {
        // Close shared browser if created
        if (sharedBrowser && sharedBrowser.isLaunched()) {
            try {
                await sharedBrowser.close();
            } catch (e) {
                logger.error('Error closing shared browser:', e);
            }
        }
        isRunning = false;
        release();
    }
};
