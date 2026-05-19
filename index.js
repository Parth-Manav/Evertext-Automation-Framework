/**
 * @module index
 * @description Main entry point for the Evertext automation framework.
 * Orchestrates startup sequence, health checks, bot initialization, and graceful shutdown.
 */

import { startScheduler, forceStop } from './src/manager.js';
import { runSetup } from './setup.js';
import { startBot, client } from './src/bot.js'; // client needed for shutdown
import { exec } from 'child_process';
import { promisify } from 'util';
import { startHealthServer } from './src/health-server.js';
import { createLogger } from './src/logger.js';

const execAsync = promisify(exec);
const logger = createLogger('main');

logger.info('Starting Evertext Auto Bot...');

/**
 * Checks for and terminates any orphaned headless Chrome processes left over
 * from previous runs to prevent memory leaks and session conflicts.
 * @returns {Promise<void>}
 */
async function killOrphanedChrome() {
    try {
        logger.info('Checking for orphaned Chrome processes...');
        const isWindows = process.platform === 'win32';
        const command = isWindows ? 'wmic process where "name=\'chrome.exe\' and commandline like \'%--headless%\'" get processid' : 'ps aux | grep chrome | grep headless | grep -v grep';

        const { stdout } = await execAsync(command).catch(() => ({ stdout: '' }));

        if (stdout.length > 5 && (stdout.includes('chrome') || stdout.match(/\d+/))) {
            logger.warn('Found orphaned headless Chrome processes. Killing...');
            const killCmd = isWindows ? 'wmic process where "name=\'chrome.exe\' and commandline like \'%--headless%\'" call terminate' : 'pkill -9 -f "chrome.*--headless"';
            await execAsync(killCmd).catch(() => { }); // Ignore errors if already dead
            logger.info('Killed orphaned Chrome processes');
            await new Promise(r => setTimeout(r, 2000));
        } else {
            logger.info('No orphaned Chrome processes found');
        }
    } catch (err) {
        logger.warn('Chrome cleanup skipped (no processes found or command failed)');
    }
}

// --- 2. Graceful Shutdown Handler ---
let isShuttingDown = false;

/**
 * Handles graceful shutdown by stopping the scheduler, disconnecting Discord,
 * and waiting for pending operations to complete.
 * @param {string} signal - The termination signal received (e.g., SIGTERM, SIGINT)
 * @returns {Promise<void>}
 */
async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info(`Received ${signal}, cleaning up...`);

    // Stop accepting new work
    forceStop();

    // Disconnect Discord bot
    if (client) {
        logger.info('Disconnecting Discord bot...');
        await client.destroy();
    }

    // Wait for ongoing cleanups
    await new Promise(r => setTimeout(r, 2000));

    logger.info('Cleanup complete. Exiting...');
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// --- Global Error Handling ---
process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// --- Main Bootstrap ---
(async () => {
    try {
        await runSetup(); // Run interactive setup if needed
        await killOrphanedChrome();

        // Start Health Check (for Zeabur)
        const port = process.env.PORT || 3000;
        startHealthServer(port);

        // Start App
        startScheduler();
        startBot();
    } catch (error) {
        logger.error('Failed to start application:', error);
        process.exit(1);
    }
})();
