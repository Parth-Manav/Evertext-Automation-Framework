import test from 'node:test';
import assert from 'node:assert/strict';

import { extractJsonLines } from '../src/brain.js';

test('extractJsonLines buffers partial stdout messages', () => {
    let parsed = extractJsonLines('', '{"action":"ready"}\n{"action":"wait"');

    assert.deepEqual(parsed.lines, ['{"action":"ready"}']);
    assert.equal(parsed.rest, '{"action":"wait"');

    parsed = extractJsonLines(parsed.rest, '}\n');

    assert.deepEqual(parsed.lines, ['{"action":"wait"}']);
    assert.equal(parsed.rest, '');
});

test('extractJsonLines ignores blank lines', () => {
    const parsed = extractJsonLines('', '\n{"action":"wait"}\n\n');

    assert.deepEqual(parsed.lines, ['{"action":"wait"}']);
    assert.equal(parsed.rest, '');
});
