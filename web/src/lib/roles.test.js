import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHeldRoles } from './roles.js';

test('a linked HR manager can switch into the employee workspace', () => {
  assert.deepEqual(
    resolveHeldRoles([{ role: 'hr_manager' }], false, [], { id: 'emp-1' }),
    ['hr_manager', 'employee']
  );
});

test('an unlinked manager is not offered an employee workspace', () => {
  assert.deepEqual(
    resolveHeldRoles([{ role: 'hr_manager' }], false, [], null),
    ['hr_manager']
  );
});

test('an explicit self-service grant still offers employee view', () => {
  assert.deepEqual(
    resolveHeldRoles(
      [{ role: 'hr_manager' }],
      false,
      [{ permission: 'leave.read', scope_type: 'self', scope_id: null }],
      null
    ),
    ['hr_manager', 'employee']
  );
});
