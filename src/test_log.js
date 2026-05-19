/**
 * @module test_log
 * @description Diagnostic script for Discord log channel delivery. Not used in production.
 */

import { sendLog, startBot } from './bot.js';
import { getLogChannel } from './db.js';
import { createLogger } from './logger.js';

const logger = createLogger('test_log');

logger.info('Starting diagnostic test (timeout method)...');

startBot();

setTimeout(async () => {
    logger.info('Waited 5s for login...');

    logger.info('Checking log channel from DB...');
    const dbChannel = await getLogChannel();
    logger.info(`DB log channel ID: ${dbChannel}`);

    logger.info('Attempting to send test log...');
    try {
        await sendLog(
            `🧪 **Diagnostic Test**: If you see this, logging is working! (Channel ID: ${dbChannel})`,
            'info'
        );
        logger.info('Test log function called — check Discord for message');
    } catch (error) {
        logger.error('Test log failed:', error);
    }

    setTimeout(() => {
        logger.info('Diagnostic complete. Exiting...');
        process.exit(0);
    }, 5000);
}, 5000);
