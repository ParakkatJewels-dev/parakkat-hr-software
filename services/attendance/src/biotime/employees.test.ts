import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
let response: unknown;
let failure: unknown;
mock.module(require.resolve('../config/env'), { namedExports: { env: {
  APP_TIMEZONE: 'Asia/Kolkata', BIOTIME_TIMEZONE: 'Asia/Kolkata',
} } });
mock.module(require.resolve('./client'), { namedExports: { biotime: {
  getAll: async () => { if (failure) throw failure; return response; },
} } });
const { fetchAllTerminals } = require('./employees') as typeof import('./employees');
const { asBigInt } = require('./types') as typeof import('./types');

test('terminal endpoints may be absent, but auth, network and malformed-response failures remain visible', async () => {
  for (const status of [404, 405]) {
    failure = Object.assign(new Error('endpoint absent'), { response: { status } });
    assert.deepEqual(await fetchAllTerminals(), []);
  }
  for (const status of [401, 403, 500]) {
    failure = Object.assign(new Error(`HTTP ${status}`), { response: { status } });
    await assert.rejects(fetchAllTerminals(), failure as Error);
  }
  failure = new Error('socket disconnected');
  await assert.rejects(fetchAllTerminals(), /socket disconnected/);
  failure = null;
});

test('terminal retrieval cannot convert cancellation into success', async () => {
  const controller = new AbortController();
  controller.abort();
  failure = controller.signal.reason;
  await assert.rejects(fetchAllTerminals(controller.signal), /abort/i);
  failure = null;
});

test('transaction IDs preserve exact bigint strings and reject already-imprecise numbers', () => {
  assert.equal(asBigInt('9007199254740993'), 9007199254740993n);
  assert.equal(asBigInt('9223372036854775807'), 9223372036854775807n);
  assert.equal(asBigInt(9007199254740992), null);
  assert.equal(asBigInt(12.5), null);
  assert.equal(asBigInt('12.5'), null);
  assert.equal(asBigInt(0), 0n);
  assert.equal(asBigInt(' 123 '), 123n);
});
