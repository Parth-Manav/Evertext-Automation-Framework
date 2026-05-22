import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BrainCommunicationError,
    ConnectionFailedError,
    IdleTimeoutError,
    SessionExpiredError,
    ValidationError,
    ZigzaError,
    isErrorCode
} from '../src/errors.js';
import {
    ERROR_CODE_CONNECTION_FAILED,
    ERROR_CODE_IDLE_TIMEOUT,
    ERROR_CODE_LOGIN_REQUIRED
} from '../src/constants.js';

test('custom errors expose stable names and codes', () => {
    assert.equal(new SessionExpiredError().code, ERROR_CODE_LOGIN_REQUIRED);
    assert.equal(new IdleTimeoutError().code, ERROR_CODE_IDLE_TIMEOUT);
    assert.equal(new ConnectionFailedError().code, ERROR_CODE_CONNECTION_FAILED);
    assert.equal(new ZigzaError().code, 'ZIGZA_DEFER');
    assert.equal(new BrainCommunicationError().name, 'BrainCommunicationError');
    assert.equal(new ValidationError().name, 'ValidationError');
});

test('isErrorCode supports coded errors and legacy message matching', () => {
    assert.equal(isErrorCode(new IdleTimeoutError(), ERROR_CODE_IDLE_TIMEOUT), true);
    assert.equal(isErrorCode(new Error(ERROR_CODE_IDLE_TIMEOUT), ERROR_CODE_IDLE_TIMEOUT), true);
    assert.equal(isErrorCode(new Error('other'), ERROR_CODE_IDLE_TIMEOUT), false);
});
