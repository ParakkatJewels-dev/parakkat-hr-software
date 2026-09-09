import test from 'node:test';
import assert from 'node:assert/strict';
import { containsOwnName, passwordProblem, RULES, MIN_LENGTH } from './passwordRules.js';

const RAMESH = { name: 'Ramesh Kumar', email: 'ramesh.kumar@parakkatjewels.com' };

test('the provisioned default itself is refused — the whole point of the gate', () => {
  // {employee_name}{last 4 of phone}
  assert.equal(containsOwnName('Ramesh4821', RAMESH), true);
  assert.equal(containsOwnName('RameshKumar4821', RAMESH), true);
  assert.ok(passwordProblem('Ramesh4821', RAMESH), 'must not be accepted as a new password');
});

test('punctuation and case do not smuggle the name past', () => {
  for (const attempt of ['R-a-m-e-s-h-2024', 'ramesh.kumar!!', 'RAMESH_9999', '  Ramesh  1234']) {
    assert.equal(containsOwnName(attempt, RAMESH), true, attempt);
  }
});

test('either half of the name is enough to catch it', () => {
  assert.equal(containsOwnName('kumar12345', RAMESH), true);
  assert.equal(containsOwnName('Ramesh!!!!', RAMESH), true);
});

test('the email local part is blocked too', () => {
  assert.equal(containsOwnName('rameshkumar1', RAMESH), true);
});

test('a genuinely different password passes', () => {
  for (const good of ['thrissur-monsoon-7', 'BlueKettle22', 'p0lishing-wheel']) {
    assert.equal(containsOwnName(good, RAMESH), false, good);
    assert.equal(passwordProblem(good, RAMESH), null, good);
  }
});

test('a short name fragment is not blocked, or half the dictionary would be', () => {
  // "Li" is two characters — blocking every password containing "li" is unusable.
  assert.equal(containsOwnName('quality-wheel-9', { name: 'Li Wu' }), false);
});

test('length is enforced, and is the first thing reported on an empty field', () => {
  assert.equal(passwordProblem('', RAMESH).id, 'length');
  assert.equal(passwordProblem('short1', RAMESH).id, 'length');
  assert.equal('exactly8'.length, MIN_LENGTH);
  assert.equal(passwordProblem('exactly8', RAMESH), null);
});

test('an all-numeric password is refused — that is what a phone number is', () => {
  assert.equal(passwordProblem('9847001234', RAMESH).id, 'variety');
  assert.equal(passwordProblem('98470012ab', RAMESH), null);
});

test('the rules work when we know nothing about the person', () => {
  assert.equal(passwordProblem('somethinglong', {}), null);
  assert.equal(containsOwnName('anything', {}), false);
  assert.equal(containsOwnName('anything', { name: null, email: undefined }), false);
});

test('every rule has an id, a label and a predicate that tolerates junk', () => {
  for (const rule of RULES) {
    assert.ok(rule.id && rule.label, 'a rule needs to be able to name itself');
    assert.doesNotThrow(() => rule.ok(undefined, {}));
    assert.doesNotThrow(() => rule.ok('', undefined));
  }
});
