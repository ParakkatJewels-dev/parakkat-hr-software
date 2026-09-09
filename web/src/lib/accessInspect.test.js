import test from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveAccess, groupByPermission, accessFlags, accessSummary, SENSITIVE,
} from './accessInspect.js';

// A cut-down catalogue in the shape useRoles() returns: role key -> the keys it carries.
const CATALOGUE = {
  employee: ['task.read', 'leave.create', 'payslip.read', 'document.read'],
  dept_head: [
    'task.read', 'task.create', 'leave.approve', 'employee.update', 'employee.create',
    'rbac.manage', 'payslip.read', 'document.read',
  ],
  hr_manager: [
    'task.read', 'task.create', 'leave.approve', 'employee.update', 'employee.create',
    'rbac.manage', 'payslip.read', 'document.read', 'payroll.manage',
  ],
};

test('a permission is tagged with the assignment that granted it', () => {
  const access = effectiveAccess(
    [{ role_key: 'dept_head', scope_type: 'department', scope_id: 'd-polishing' }],
    CATALOGUE
  );
  const approve = access.find((a) => a.permission === 'leave.approve');
  assert.deepEqual(approve, {
    permission: 'leave.approve',
    scope_type: 'department',
    scope_id: 'd-polishing',
    via: 'dept_head',
  });
});

test('holding a permission twice keeps both routes, because both must be removed', () => {
  const access = effectiveAccess(
    [
      { role_key: 'dept_head', scope_type: 'department', scope_id: 'd1' },
      { role_key: 'hr_manager', scope_type: 'entity', scope_id: 'e1' },
    ],
    CATALOGUE
  );
  const grouped = groupByPermission(access);
  const update = grouped.find((g) => g.permission === 'employee.update');
  assert.equal(update.sources.length, 2);
  assert.deepEqual(update.sources.map((s) => s.via).sort(), ['dept_head', 'hr_manager']);
});

test('a self-scoped grant is not oversight', () => {
  const access = effectiveAccess(
    [{ role_key: 'employee', scope_type: 'self', scope_id: null }],
    CATALOGUE
  );
  const grouped = groupByPermission(access);
  assert.equal(grouped.find((g) => g.permission === 'payslip.read').beyondSelf, false);
});

test('an employee reading their OWN payslip is not flagged', () => {
  const access = effectiveAccess(
    [{ role_key: 'employee', scope_type: 'self', scope_id: null }],
    CATALOGUE
  );
  const keys = accessFlags(access).map((f) => f.permission);
  assert.ok(!keys.includes('payslip.read'), 'own payslip must not raise a flag');
  assert.ok(!keys.includes('document.read'), 'own documents must not raise a flag');
});

test('a department head reading the department’s payslips IS flagged', () => {
  const access = effectiveAccess(
    [{ role_key: 'dept_head', scope_type: 'department', scope_id: 'd1' }],
    CATALOGUE
  );
  const flags = accessFlags(access);
  const keys = flags.map((f) => f.permission);
  assert.ok(keys.includes('payslip.read'));
  assert.ok(keys.includes('document.read'));
  assert.ok(keys.includes('employee.update'), 'bank and statutory ids ride on employee.update');
});

test('flags come back most severe first', () => {
  const access = effectiveAccess(
    [{ role_key: 'hr_manager', scope_type: 'entity', scope_id: 'e1' }],
    CATALOGUE
  );
  const severities = accessFlags(access).map((f) => f.severity);
  const rank = { high: 0, medium: 1, low: 2 };
  const sorted = [...severities].sort((a, b) => rank[a] - rank[b]);
  assert.deepEqual(severities, sorted);
});

test('a super admin holds the whole catalogue at global scope', () => {
  const access = effectiveAccess([], CATALOGUE, { isSuperAdmin: true });
  const everyKey = new Set(Object.values(CATALOGUE).flat());
  assert.equal(access.length, everyKey.size);
  assert.ok(access.every((a) => a.scope_type === 'global' && a.via === 'super_admin'));
});

test('an assignment for a role the catalogue does not know contributes nothing', () => {
  const access = effectiveAccess(
    [{ role_key: 'auditor', scope_type: 'entity', scope_id: 'e1' }],
    CATALOGUE
  );
  assert.deepEqual(access, []);
});

test('no assignments means no access, and a summary that says so', () => {
  const s = accessSummary(effectiveAccess([], CATALOGUE));
  assert.deepEqual(s, { total: 0, beyondSelf: 0, selfOnly: 0, flags: 0 });
});

test('the summary separates what reaches other people from what does not', () => {
  const access = effectiveAccess(
    [
      { role_key: 'dept_head', scope_type: 'department', scope_id: 'd1' },
      { role_key: 'employee', scope_type: 'self', scope_id: null },
    ],
    CATALOGUE
  );
  const s = accessSummary(access);
  assert.equal(s.total, new Set(Object.values(CATALOGUE).flat().filter((k) =>
    CATALOGUE.dept_head.includes(k) || CATALOGUE.employee.includes(k))).size);
  assert.ok(s.beyondSelf > 0);
  assert.equal(s.total, s.beyondSelf + s.selfOnly);
});

test('every sensitive rule names a real severity and carries its reasoning', () => {
  for (const rule of SENSITIVE) {
    assert.ok(['high', 'medium', 'low'].includes(rule.severity), rule.permission);
    assert.ok(rule.label && rule.why, `${rule.permission} needs a label and a why`);
  }
});
