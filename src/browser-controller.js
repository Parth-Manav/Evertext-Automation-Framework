/**
 * @module browser-controller
 * @description Puppeteer wrapper responsible for Chromium lifecycle management.
 * Handles browser launch, cookie injection, and UI interaction (Start/Stop buttons).
 * Intentionally decoupled from WebSocket logic to allow session reuse across accounts.
 */

import puppeteer from 'puppeteer';
import { createLogger } from './logger.js';
import { SessionExpiredError } from './errors.js';

const logger = createLogger('browser-controller');
const GAME_URL = 'https://evertext.sytes.net';

/**
 * Controller class for managing the Puppeteer browser instance and pages.
 */
export class BrowserController {
    constructor() {
        /** @type {import('puppeteer').Browser | null} */
        this.browser = null;
        /** @type {import('puppeteer').BrowserContext | null} */
        this.context = null; // Store Incognito Context
        /** @type {import('puppeteer').Page | null} */
        this.page = null;
    }

    /**
     * Launches a Chromium instance and injects session cookies.
     * Reuses an existing browser process if provided.
     * @param {string} sessionCookie - Serialized cookie string from the game session.
     * @param {import('puppeteer').Browser | null} [sharedBrowser=null] - Optional shared browser instance to reuse.
     * @returns {Promise<void>} Resolves when the browser is ready and navigated to the game URL.
     * @throws {Error} If the browser fails to launch or cookies are malformed.
     */
    async launch(sessionCookie, sharedBrowser = null) {
        logger.info('Launching Session...');

        if (sharedBrowser) {
            logger.info('Reusing existing browser instance');
            this.browser = sharedBrowser;
        } else {
            // Launch new browser if none provided
            logger.info('Starting new Chromium process...');
            this.browser = await puppeteer.launch({
                headless: false, // Visible GUI requested by user
                timeout: 30000,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-software-rasterizer',
                    '--disable-accelerated-2d-canvas',
                    '--disable-accelerated-video-decode',
                    '--disable-3d-apis',
                    '--no-zygote',
                    '--disable-extensions',
                    '--disable-component-extensions-with-background-pages',
                    '--disable-default-apps',
                    '--disable-sync',
                    '--disable-translate',
                    '--disable-notifications',
                    '--disable-speech-api',
                    '--disable-webgl',
                    '--disable-web-security',
                    '--disk-cache-size=1',
                    '--media-cache-size=1',
                    '--aggressive-cache-discard',
                    '--disable-cache',
                    '--disable-application-cache',
                    '--disable-offline-load-stale-cache',
                    '--disable-renderer-backgrounding',
                    '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-ipc-flooding-protection',
                    '--js-flags=--max-old-space-size=128',
                    '--window-size=800,600',
                    '--no-first-run',
                    '--mute-audio'
                ]
            });
        }

        // --- OPTIMIZATION: Incognito Context ---
        // Creates a clean slate instantly (no cookies/cache from previous run)
        logger.info('Creating Incognito Context...');
        this.context = await this.browser.createBrowserContext();
        this.page = await this.context.newPage();

        await this.page.setViewport({ width: 800, height: 600 });

        // CLEANUP: Close the initial blank window(s) from the default context
        // Now that we have our Incognito window open, it's safe to close the others
        try {
            const allPages = await this.browser.pages();
            for (const p of allPages) {
                // CRITICAL FIX: Don't close the page we just created!
                if (p !== this.page) {
                    await p.close().catch(() => { });
                }
            }
        } catch (e) {
            logger.warn(`Could not close default page: ${e.message}`);
        }

        // Inject session cookie
        if (sessionCookie) {
            logger.info('Injecting session cookie...');
            await this.page.setCookie({
                name: 'session',
                value: sessionCookie,
                domain: new URL(GAME_URL).hostname,
                path: '/',
                httpOnly: true
            });
        }

        //Navigate to game
        logger.info('Navigating to game terminal...');
        await this.page.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });

        logger.info('Browser ready');
    }

    /**
     * Clicks the "Start" button in the web UI to initiate the terminal connection.
     * Handles refreshing the page if the button is disabled from a previous session.
     * @returns {Promise<void>} Resolves when the terminal is successfully started.
     * @throws {Error} If the browser has not been launched or the button is unavailable.
     */
    async clickStart() {
        if (!this.page) throw new Error('Browser not launched');

        logger.info('Preparing to start terminal...');

        // Wait for button to be available
        await this.page.waitForSelector('#startBtn', { timeout: 10000 });

        // Check if button is disabled (previous session still running)
        const isDisabled = await this.page.evaluate(() => {
            const btn = document.getElementById('startBtn');
            return btn ? btn.disabled : true;
        });

        if (isDisabled) {
            logger.info('Start button disabled. Refreshing...');
            await this.page.reload({ waitUntil: 'domcontentloaded' });
            await this.page.waitForSelector('#startBtn', { timeout: 10000 });
        }

        logger.info('Clicking Start button...');
        await this.page.click('#startBtn');

        // Wait for terminal to initialize
        await this.page.waitForSelector('#connection_status', { timeout: 10000 });

        // Give terminal a moment to fully connect
        await new Promise(r => setTimeout(r, 1000));

        logger.info('Terminal started and ready');
    }

    /**
     * Clicks the "Stop" button in the web UI to cleanly disconnect the terminal.
     * Polls the UI to confirm the termination process completes.
     * @returns {Promise<void>} Resolves when the terminal is fully stopped.
     * @throws {Error} If the browser has not been launched.
     */
    async clickStop() {
        if (!this.page) throw new Error('Browser not launched');

        logger.info('Clicking Stop button...');

        try {
            // Check if stop button exists
            const stopBtn = await this.page.$('#stopBtn');
            if (stopBtn) {
                await this.page.click('#stopBtn');

                // --- OPTIMIZATION: Smart Waiting ---
                logger.info('Waiting for terminal process to stop...');
                try {
                    // Poll element state instead of hard sleep
                    // Wait until Start Button is ENABLED again
                    await this.page.waitForFunction(() => {
                        const btn = document.getElementById('startBtn');
                        return btn && !btn.disabled;
                    }, { timeout: 5000, polling: 200 }); // Check every 200ms
                    logger.info('Terminal fully stopped (Start button re-enabled)');
                } catch (e) {
                    logger.warn('Stop confirmation timed out, but proceeding.');
                }

            } else {
                logger.info('Stop button not found (terminal probably already stopped)');
            }
        } catch (e) {
            logger.error(`Failed to click stop: ${e.message}`);
        }
    }

    /**
     * Refreshes the active game page.
     * @returns {Promise<void>}
     * @throws {Error} If the browser has not been launched.
     */
    async refresh() {
        if (!this.page) throw new Error('Browser not launched');

        logger.info('Refreshing page...');
        await this.page.reload({ waitUntil: 'domcontentloaded' });
    }

    /**
     * Checks if the active page requires the user to log in (session expired).
     * @returns {Promise<boolean>} True if the login link is present on the page.
     * @throws {Error} If the browser has not been launched.
     */
    async isLoginRequired() {
        if (!this.page) throw new Error('Browser not launched');

        const loginLink = await this.page.$('a[href="/auth/google"]');
        return loginLink !== null;
    }

    /**
     * Closes the incognito context (cleaning up cookies and cache).
     * The manager handles closing the underlying shared browser process.
     * @returns {Promise<void>}
     */
    async close() {
        // Close Context (Incognito Tab)
        if (this.context) {
            logger.info('Closing Incognito Context...');
            try { await this.context.close(); } catch (e) { }
            this.context = null;
            this.page = null;
        }

        // IMPORTANT: We do NOT close this.browser here if it was shared.
        // The manager handles closing the actual browser process.
    }

    /**
     * Checks if the browser page is currently active.
     * @returns {boolean} True if the page instance exists.
     */
    isLaunched() {
        return this.page !== null;
    }
}
