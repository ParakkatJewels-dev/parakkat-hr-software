import test from 'node:test';
import assert from 'node:assert/strict';
import { loginCredentials, loginErrorMessage, loginHandover, signInWithEmail } from './login.js';

test('sign-in uses normalized work email and preserves every password character', async () => {
  const form = new FormData();
  form.set('email', ' Person@Example.COM ');
  form.set('password', ' Mixed Case!9 ');
  const credentials = loginCredentials(form);
  assert.deepEqual(credentials, { email: 'person@example.com', password: ' Mixed Case!9 ' });
  const calls = [];
  const response = { data: { session: { user: { id: 'person' } } }, error: null };
  assert.equal(await signInWithEmail({ signInWithPassword: async (args) => { calls.push(args); return response; } },
    ' PERSON@Example.COM ', credentials.password), response);
  assert.deepEqual(calls, [credentials]);
});

test('connection and rate-limit failures do not falsely report an incorrect password', () => {
  assert.match(loginErrorMessage({ code: 'invalid_credentials' }), /email or password is incorrect/);
  assert.match(loginErrorMessage({ message: 'Invalid login credentials' }), /latest password/);
  for (const error of [new TypeError('Failed to fetch'), { name: 'AuthRetryableFetchError' }, { status: 503 }]) {
    assert.match(loginErrorMessage(error), /connection/);
    assert.doesNotMatch(loginErrorMessage(error), /incorrect/);
  }
  assert.match(loginErrorMessage({ status: 429 }), /Wait a few minutes/);
  assert.match(loginErrorMessage({ code: 'over_request_rate_limit' }), /Wait a few minutes/);
  assert.match(loginErrorMessage({ code: 'email_not_confirmed' }), /not been confirmed/);
  assert.match(loginErrorMessage({ code: 'user_banned' }), /disabled/);
  assert.doesNotMatch(loginErrorMessage({ message: 'opaque response with submitted secret' }), /submitted secret/);
});

test('only newly created logins display the password actually supplied or provisioned', () => {
  assert.deepEqual(loginHandover({ created: true, email: 'new@example.test' }, { name: 'New', password: 'Chosen!42' }),
    { created: true, name: 'New', email: 'new@example.test', password: 'Chosen!42' });
  assert.equal(loginHandover({ created: true, email: 'new@example.test', password: 'Derived!42', grant: { created: true } }).password, 'Derived!42');
});

test('reused and older incorrectly reported provisioning results never expose an unsaved password', () => {
  for (const result of [
    { created: false, email: 'existing@example.test' },
    { created: true, email: 'existing@example.test', password: 'Wrong!42', grant: { created: false } },
    { email: 'existing@example.test' },
  ]) {
    const handover = loginHandover(result, { name: 'Existing', password: 'Proposed!42' });
    assert.equal(handover.created, false);
    assert.equal(handover.password, null);
    assert.equal(handover.email, 'existing@example.test');
  }
  assert.equal(loginHandover(null), null);
});
