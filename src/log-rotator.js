/**
 * @module log-rotator
 * @description Removes stale log, temp, and screenshot files from the project root.
 */

import fs from 'fs/promises';
import { createLogger } from './logger.js';
import { LOG_ROTATION_MAX_AGE_MS } from './constants.js';

const logger = createLogger('maintenance');

/**
 * Deletes `.log`, `.tmp`, and `.png` files older than 24 hours in the project root.
 * @returns {Promise<void>}
 */
export const rotateLogs = async () => {
    try {
        const files = await fs.readdir('.');
        const now = Date.now();
        let deletedCount = 0;

        for (const file of files) {
            if (file.endsWith('.log') || file.endsWith('.tmp') || file.endsWith('.png')) {
                const stats = await fs.stat(file);
                if (now - stats.mtimeMs > LOG_ROTATION_MAX_AGE_MS) {
                    await fs.unlink(file);
                    deletedCount++;
                }
            }
        }

        if (deletedCount > 0) {
            logger.info(`Cleaned up ${deletedCount} old temp/log files.`);
        }
    } catch (err) {
        logger.error('Log rotation failed:', err.message);
    }
};
