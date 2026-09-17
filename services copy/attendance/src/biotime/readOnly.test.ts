// Proof that nothing can write to Easy Time Pro.
//
//   npx tsx --test src/biotime/readOnly.test.ts
//
// The service reads an attendance system HR depends on and payroll is calculated from, in a
// database we do not own and cannot roll back. "Nothing writes today" is a fact about the current
// code; this makes it a property of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { enforceReadOnly, BiotimeWriteBlocked } from './readOnly';

const dataClient = () => enforceReadOnly(axios.create({ baseURL: 'http://127.0.0.1:9' }));
const authClient = () => enforceReadOnly(axios.create({ baseURL: 'http://127.0.0.1:9' }), { allowAuth: true });

// Port 9 discards everything, so a request that gets past the guard fails on connection instead —
// which is how we tell "blocked" apart from "allowed but unreachable".
const blocked = async (fn: () => Promise<unknown>) => {
  try { await fn(); return false; }
  catch (e) { return e instanceof BiotimeWriteBlocked; }
};

test('every write verb is refused on the data client', async () => {
  const c = dataClient();
  for (const [name, call] of [
    ['post',   () => c.post('/personnel/api/employees/', { name: 'x' })],
    ['put',    () => c.put('/personnel/api/employees/1/', { name: 'x' })],
    ['patch',  () => c.patch('/personnel/api/employees/1/', { name: 'x' })],
    ['delete', () => c.delete('/iclock/api/transactions/1/')],
  ] as const) {
    assert.equal(await blocked(call), true, `${name} must be refused`);
  }
});

test('reads are allowed through', async () => {
  const c = dataClient();
  // Reaches the network and fails there — not refused by the guard.
  assert.equal(await blocked(() => c.get('/iclock/api/transactions/')), false);
  assert.equal(await blocked(() => c.head('/iclock/api/transactions/')), false);
});

test('the login POST is allowed, but only on the auth client and only on the auth path', async () => {
  const auth = authClient();
  assert.equal(await blocked(() => auth.post('/api-token-auth/', {})), false, 'token login');
  assert.equal(await blocked(() => auth.post('/jwt-api-token-auth/', {})), false, 'jwt login');

  // Even holding the auth exemption, it cannot post anywhere else.
  assert.equal(await blocked(() => auth.post('/personnel/api/employees/', {})), true,
    'the exemption is for logging in, not for writing data');
});

test('the data client cannot log in either, so the exemption cannot leak', async () => {
  assert.equal(await blocked(() => dataClient().post('/api-token-auth/', {})), true);
});

test('the refusal explains itself', async () => {
  try {
    await dataClient().delete('/iclock/api/transactions/1/');
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof BiotimeWriteBlocked);
    assert.match((e as Error).message, /read-only by design/);
    assert.match((e as Error).message, /DELETE/);
  }
});
