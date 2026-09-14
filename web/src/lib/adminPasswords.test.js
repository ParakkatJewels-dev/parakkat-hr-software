import { test } from 'node:test';
import assert from 'node:assert/strict';
import { temporaryPasswordProblem, setManagedUserPassword } from './adminPasswords.js';

const target = { employee_name: 'Sample Employee', email: 'person@example.test' };

test('temporary passwords use the target identity, confirmation and UTF-8 byte limit', () => {
  assert.equal(temporaryPasswordProblem('MapleRiver!42', 'MapleRiver!42', target), null);
  assert.match(temporaryPasswordProblem('SampleRiver!42', 'SampleRiver!42', target), /person's name/);
  assert.match(temporaryPasswordProblem('PersonRiver!42', 'PersonRiver!42', target), /person's name/);
  assert.match(temporaryPasswordProblem('MapleRiver!42', 'MapleRiver!43', target), /do not match/);
  assert.match(temporaryPasswordProblem('short', 'short', target), /At least 8/);
  assert.match(temporaryPasswordProblem('12345678', '12345678', target), /Not only numbers/);
  assert.match(temporaryPasswordProblem('🌲'.repeat(4), '🌲'.repeat(4), target), /At least 8/);
  assert.equal(temporaryPasswordProblem('🌲'.repeat(18), '🌲'.repeat(18), target), null);
  assert.match(temporaryPasswordProblem('🌲'.repeat(19), '🌲'.repeat(19), target), /at most 72 bytes/);
});

test('admin temporary password change targets the privileged RPC and never the admin auth account', async () => {
  const calls = [];
  await setManagedUserPassword({
    rpc: async (...args) => { calls.push(args); return { data: null, error: null }; },
    auth: { updateUser: () => assert.fail('must never update the administrator') },
  }, { user_id: 'target-user', password: 'MapleRiver!42' });
  assert.deepEqual(calls, [['admin_set_user_password', { _user_id: 'target-user', _password: 'MapleRiver!42' }]]);
});

test('password errors preserve known actions and never expose an echoed password', async () => {
  const secret = 'MapleRiver!42';
  const call = (error) => setManagedUserPassword({ rpc: async () => ({ error }) }, { user_id: 'target', password: secret });
  await assert.rejects(call({ code: 'PGRST202', message: secret }), /server needs to be updated/);
  await assert.rejects(call({ code: '42501', message: secret }), /do not have permission/);
  await assert.rejects(call({ code: '22000', message: secret }), (error) => !error.message.includes(secret) && /password rules/.test(error.message));
  await assert.rejects(setManagedUserPassword({ rpc: async () => { throw new Error(secret); } }, { user_id: 'target', password: secret }), /Check your connection/);
});
