// The app's name follows the person using it.
//
//   node --test src/lib/appName.test.js
//
// Two things are worth pinning down. The names have to cover the whole role ladder — a role added
// to ROLE_PRIORITY without a name here silently falls back to the product name, which is not wrong
// but is not what anyone intended. And the fallback itself must not be one of the real names, or an
// unrecognised role would be told it has a workspace, or a console, that it may not have.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appNameFor, documentTitleFor, PRODUCT_NAME, ORG_NAME } from './appName.js';
import { ROLE_PRIORITY } from './roles.js';

test('every role on the ladder has a name of its own', () => {
  const names = ROLE_PRIORITY.map(appNameFor);
  for (const [i, role] of ROLE_PRIORITY.entries()) {
    assert.notEqual(names[i], PRODUCT_NAME, `${role} fell through to the generic product name`);
  }
  assert.equal(new Set(names).size, names.length, 'two roles share a name, so the title says nothing');
});

test('an employee is not told they are in an HR system', () => {
  assert.equal(appNameFor('employee'), 'My Workspace');
  // The heading App.jsx puts above the same person's nav. If these drift the sidebar contradicts
  // itself — the header naming one thing and the section below it naming another.
  assert.match(appNameFor('employee'), /workspace/i);
});

test('an unknown or missing role gets the product name, not somebody else\'s view', () => {
  for (const role of ['a_custom_role', '', null, undefined]) {
    assert.equal(appNameFor(role), PRODUCT_NAME, `${String(role)} should fall back`);
  }
  // Specifically NOT the two that would misdescribe what they can do.
  assert.notEqual(appNameFor('a_custom_role'), 'My Workspace');
  assert.notEqual(appNameFor('a_custom_role'), 'HR Console');
});

test('the tab names the role first and the company last', () => {
  assert.equal(documentTitleFor('employee'), `My Workspace · ${ORG_NAME}`);
  assert.equal(documentTitleFor('super_admin'), `HR Console · ${ORG_NAME}`);
});

// "Parakkat HR · Parakkat" — the fallback name already contains the company, so the suffix that
// every other name needs is the one thing this one must not get.
test('the company is not said twice when the name already contains it', () => {
  assert.equal(documentTitleFor('a_custom_role'), PRODUCT_NAME);
  assert.equal(documentTitleFor('a_custom_role', 'Leave'), `Leave · ${PRODUCT_NAME}`);
  assert.doesNotMatch(documentTitleFor('a_custom_role'), /Parakkat.*Parakkat/);
});

test('a screen name goes in front, and an absent one does not leave a stray separator', () => {
  assert.equal(documentTitleFor('employee', 'Leave'), `Leave · My Workspace · ${ORG_NAME}`);
  for (const empty of [undefined, null, '']) {
    assert.equal(documentTitleFor('employee', empty), `My Workspace · ${ORG_NAME}`);
  }
});
