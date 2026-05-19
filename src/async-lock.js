/**
 * @module async-lock
 * @description Simple async mutex to prevent concurrent queue processing race conditions.
 */

/**
 * FIFO async lock — only one caller holds the lock at a time.
 */
export class AsyncLock {
    constructor() {
        /** @type {boolean} */
        this.locked = false;
        /** @type {Array<() => void>} */
        this.queue = [];
    }

    /**
     * Acquires the lock. Resolves with a `release` function when the lock is held.
     * @returns {Promise<() => void>} Release callback — must be invoked when done.
     */
    async acquire() {
        return new Promise((resolve) => {
            const releaseFn = () => this.release();
            if (!this.locked) {
                this.locked = true;
                resolve(releaseFn);
            } else {
                this.queue.push(() => resolve(releaseFn));
            }
        });
    }

    /**
     * Releases the lock and grants it to the next waiter, if any.
     * @returns {void}
     */
    release() {
        if (this.queue.length > 0) {
            const next = this.queue.shift();
            next();
        } else {
            this.locked = false;
        }
    }
}
