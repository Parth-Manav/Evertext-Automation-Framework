/**
 * @module health-server
 * @description HTTP health-check endpoint for container orchestration and uptime monitoring.
 */

import http from 'http';
import { createLogger } from './logger.js';

const logger = createLogger('health');

/** @type {boolean} */
let isHealthy = true;

/** @type {number} */
let lastActivityTime = Date.now();

/**
 * Starts a minimal HTTP server exposing `/health` and `/ping` endpoints.
 * @param {number} [port=3000] - Port to listen on (overridden by `PORT` env in index.js).
 * @returns {import('http').Server} The HTTP server instance.
 */
export function startHealthServer(port = 3000) {
    const server = http.createServer((req, res) => {
        if (req.url === '/health' || req.url === '/ping') {
            const uptimeSeconds = Math.floor(process.uptime());
            const timeSinceActivity = Date.now() - lastActivityTime;
            const healthy = isHealthy;

            res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: healthy ? 'ok' : 'degraded',
                uptime: uptimeSeconds,
                lastActivitySeconds: Math.floor(timeSinceActivity / 1000),
                memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
            }));
        } else {
            res.writeHead(404);
            res.end('Not Found');
        }
    });

    server.listen(port, () => {
        logger.info(`Server listening on port ${port}`);
    });

    server.on('error', (err) => {
        logger.error('Server error:', err.message);
    });

    return server;
}

/**
 * Records activity for the health endpoint's last-activity metric.
 * @returns {void}
 */
export function updateActivity() {
    lastActivityTime = Date.now();
}

/**
 * Marks the process as healthy or degraded for health-check responses.
 * @param {boolean} healthy - Whether the orchestrator should report ok status.
 * @returns {void}
 */
export function setHealthy(healthy) {
    isHealthy = healthy;
}
