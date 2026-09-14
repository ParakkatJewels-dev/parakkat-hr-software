import test from 'node:test';
import assert from 'node:assert/strict';
import { passwordProblem, RULES, MIN_LENGTH } from './passwordRules.js';

const RAMESH = { name: 'Ramesh Kumar', email: 'ramesh.kumar@parakkatjewels.com' };

test('names and usernames are allowed in a replacement password', () => {
  for (const password of ['Ramesh4821', 'RameshKumar4821', 'kumar12345', 'rameshkumar1']) {
    assert.equal(passwordProblem(password, RAMESH), null, password);
  }
});

test('names are allowed regardless of punctuation and case', () => {
  for (const attempt of ['R-a-m-e-s-h-2024', 'ramesh.kumar!!', 'RAMESH_9999', '  Ramesh  1234']) {
    assert.equal(passwordProblem(attempt, RAMESH), null, attempt);
  }
});

test('email local parts and complete Gmail addresses are allowed', () => {
  assert.equal(passwordProblem(RAMESH.email, RAMESH), null);
  assert.equal(passwordProblem('ramesh.kumar@gmail.com', RAMESH), null);
});

test('a genuinely different password passes', () => {
  for (const good of ['thrissur-monsoon-7', 'BlueKettle22', 'p0lishing-wheel']) {
    assert.equal(passwordProblem(good, RAMESH), null, good);
  }
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
  assert.equal(passwordProblem('anything', { name: null, email: undefined }), null);
});

test('every rule has an id, a label and a predicate that tolerates junk', () => {
  for (const rule of RULES) {
    assert.ok(rule.id && rule.label, 'a rule needs to be able to name itself');
    assert.doesNotThrow(() => rule.ok(undefined, {}));
    assert.doesNotThrow(() => rule.ok('', undefined));
  }
});
