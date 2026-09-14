import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDeveloperKey, fetchDeveloperKeys, fetchDeveloperSettings, saveDeveloperSettings,
  revokeDeveloperKey, developerKeysKey, developerSettingsKey, developerKeyStatus,
} from './developerSettings.js';

const metadata = { id: 'key-1', name: 'Directory sync', key_prefix: 'phr_test_1234',
  scopes: ['employees:read'], entity_id: 'company-1', created_at: '2026-09-14T00:00:00Z',
  expires_at: '2026-12-13T00:00:00Z', last_used_at: null, revoked_at: null };
const secret = 'synthetic-api-key-used-only-in-tests';
function stub(data, error = null) {
  const calls = [];
  return { calls, rpc(...args) {
    calls.push(args);
    const request = Promise.resolve({ data, error });
    request.range = (from, to) => Promise.resolve({ data: Array.isArray(data) ? data.slice(from, to + 1) : data, error });
    return request;
  } };
}

test('key and settings caches belong to the signed-in account', () => {
  assert.notDeepEqual(developerKeysKey('a'), developerKeysKey('b'));
  assert.notDeepEqual(developerSettingsKey('a'), developerSettingsKey('b'));
  assert.deepEqual(developerKeysKey(), ['developer-api-keys', null]);
});

test('listing allowlists metadata and drops any unexpected plaintext or hash', async () => {
  const client = stub([{ ...metadata, api_key: secret, key_hash: 'not-for-cache', extra: { secret }, scopes: ['employees:read', 'all:write'] }]);
  assert.deepEqual(await fetchDeveloperKeys(client), [metadata]);
  assert.ok(client.calls.length > 1, 'probe the end rather than trusting the server page size');
  assert.ok(client.calls.every(([name]) => name === 'list_developer_api_keys'));
  const settings = await fetchDeveloperSettings(stub({ enabled: false, updated_at: null, api_key: secret }));
  assert.deepEqual(settings, { enabled: false, updated_at: null });
});

test('creation returns the one-time key directly and sends only selected scopes/company/expiry', async () => {
  const client = stub({ api_key: secret, key: { ...metadata, key_hash: 'private' } });
  const result = await createDeveloperKey(client, { name: ' Directory sync ', scopes: ['employees:read', 'employees:read'], entityId: 'company-1', expiresInDays: 90 });
  assert.deepEqual(result, { api_key: secret, key: metadata });
  assert.deepEqual(client.calls, [['create_developer_api_key', {
    _name: 'Directory sync', _scopes: ['employees:read'], _entity_id: 'company-1', _expires_in_days: 90,
  }]]);
});

test('invalid creation cannot issue a backend request', async () => {
  const client = { rpc() { assert.fail('invalid input must not be submitted'); } };
  const valid = { name: 'Sync', scopes: ['employees:read'] };
  for (const values of [{}, { ...valid, name: ' ' }, { ...valid, name: 'x'.repeat(81) },
    { ...valid, scopes: [] }, { ...valid, scopes: ['employees:write'] },
    { ...valid, expiresInDays: 0 }, { ...valid, expiresInDays: 366 },
    { ...valid, expiresInDays: 1.5 }, { ...valid, entityId: {} }]) {
    await assert.rejects(createDeveloperKey(client, values));
  }
});

test('master setting and revocation use separate privileged RPCs', async () => {
  const settings = stub({ enabled: true, updated_at: '2026-09-14T00:00:00Z' });
  assert.equal((await saveDeveloperSettings(settings, true)).enabled, true);
  assert.deepEqual(settings.calls, [['set_developer_settings', { _enabled: true }]]);
  await assert.rejects(saveDeveloperSettings(settings, 'true'));
  assert.equal(settings.calls.length, 1);
  const revoke = stub(null);
  await revokeDeveloperKey(revoke, 'key-1');
  assert.deepEqual(revoke.calls, [['revoke_developer_api_key', { _key_id: 'key-1' }]]);
});

test('errors never echo a key, hash or backend request details', async () => {
  for (const code of ['PGRST202', '42501', 'PT403', 'PT401', 'PT400', 'PT429', 'PT404', 'unknown']) {
    const client = stub(null, { code, message: secret, details: secret, hint: secret });
    await assert.rejects(createDeveloperKey(client, { name: 'Sync', scopes: ['employees:read'] }),
      (error) => !error.message.includes(secret));
  }
  await assert.rejects(fetchDeveloperKeys({ rpc() { throw new Error(secret); } }),
    (error) => /Check your connection/.test(error.message) && !error.message.includes(secret));
});

test('malformed responses do not silently become empty settings or usable keys', async () => {
  await assert.rejects(fetchDeveloperKeys(stub({ api_key: secret })));
  await assert.rejects(fetchDeveloperSettings(stub(null)));
  await assert.rejects(createDeveloperKey(stub({ key: metadata }), { name: 'Sync', scopes: ['employees:read'] }), /revoke that key/);
});

test('read requests carry query cancellation to the Supabase request', async () => {
  const signal = new AbortController().signal;
  const client = { rpc: () => ({ range(from, to) { return { abortSignal(value) {
    assert.equal(value, signal);
    return Promise.resolve({ data: [metadata].slice(from, to + 1), error: null });
  } }; } }) };
  assert.deepEqual(await fetchDeveloperKeys(client, signal), [metadata]);
});

test('server row caps cannot hide an older active key behind revoked keys', async () => {
  const all = Array.from({ length: 7 }, (_, index) => ({ ...metadata, id: `key-${index}`,
    revoked_at: index < 6 ? metadata.created_at : null, api_key: secret, secret_hash: secret }));
  const ranges = [];
  const client = { rpc: () => ({ range(from, to) {
    ranges.push([from, to]);
    return Promise.resolve({ data: all.slice(from, Math.min(to + 1, from + 2)), error: null });
  } }) };
  const keys = await fetchDeveloperKeys(client);
  assert.equal(keys.length, 7);
  assert.equal(keys.at(-1).id, 'key-6');
  assert.equal(keys.at(-1).revoked_at, null);
  assert.ok(ranges.length > 3);
  assert.ok(!JSON.stringify(keys).includes(secret));
});

test('revoked and expired keys never display as active, including expiry boundary and invalid dates', () => {
  const now = Date.parse(metadata.expires_at);
  assert.equal(developerKeyStatus(metadata, now - 1), 'active');
  assert.equal(developerKeyStatus(metadata, now), 'expired');
  assert.equal(developerKeyStatus({ ...metadata, revoked_at: metadata.created_at }, now), 'revoked');
  assert.equal(developerKeyStatus({ ...metadata, expires_at: 'invalid' }, now), 'expired');
});
