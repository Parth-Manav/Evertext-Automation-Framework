import test from 'node:test';
import assert from 'node:assert/strict';

import { AsyncLock } from '../src/async-lock.js';

test('AsyncLock grants access in FIFO order', async () => {
    const lock = new AsyncLock();
    const order = [];

    const releaseFirst = await lock.acquire();

    const second = lock.acquire().then((release) => {
        order.push('second');
        release();
    });
    const third = lock.acquire().then((release) => {
        order.push('third');
        release();
    });

    order.push('first');
    releaseFirst();
    await Promise.all([second, third]);

    assert.deepEqual(order, ['first', 'second', 'third']);
});
