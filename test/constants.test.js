import test from 'node:test';
import assert from 'node:assert/strict';

import { GAME_URL, TARGET_NAME, WS_BASE_URL } from '../src/constants.js';

test('target configuration has safe defaults and valid URL shapes', () => {
    assert.equal(TARGET_NAME.length > 0, true);
    assert.doesNotThrow(() => new URL(GAME_URL));
    assert.doesNotThrow(() => new URL(WS_BASE_URL));
});
