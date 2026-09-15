import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appNameFor, appIdentityFor, appRoleFor, documentTitleFor, PRODUCT_NAME } from './appName.js';
import { ROLE_PRIORITY } from './roles.js';

test('all standard roles use the agreed app names', () => {
  assert.deepEqual(ROLE_PRIORITY.map(appNameFor), [
    'Parakkat Admin', 'Parakkat Admin', 'Parakkat HR', 'Parakkat Manager',
    'Parakkat Manager', 'Parakkat Manager', 'Parakkat Employee',
  ]);
});

test('unknown or missing roles use the neutral brand', () => {
  for (const role of ['custom_role', '', null, undefined, '__proto__', 'constructor']) {
    assert.equal(appNameFor(role), PRODUCT_NAME);
    assert.equal(appIdentityFor(role).manifestHref, '/manifest.webmanifest');
  }
});

test('installation follows the highest actual assignment, independent of assignment order', () => {
  const assignments = [{ role: 'employee' }, { role: 'branch_manager' }, { role: 'hr_manager' }];
  assert.equal(appRoleFor(assignments, false), 'hr_manager');
  assert.equal(appRoleFor(assignments.toReversed(), false), 'hr_manager');
  assert.equal(appRoleFor(assignments, true), 'super_admin');
  assert.equal(appRoleFor([{ role: 'custom_role' }], false), null);
  assert.equal(appRoleFor([], false), null);
  assert.equal(appRoleFor(undefined, false), null);
});

test('browser titles identify the app and current screen without repeating the company', () => {
  assert.equal(documentTitleFor('employee'), 'Parakkat Employee');
  assert.equal(documentTitleFor('super_admin', 'Settings'), 'Settings · Parakkat Admin');
  assert.equal(documentTitleFor('unknown', 'Leave'), `Leave · ${PRODUCT_NAME}`);
  for (const empty of [undefined, null, '']) {
    assert.equal(documentTitleFor('employee', empty), 'Parakkat Employee');
  }
});
