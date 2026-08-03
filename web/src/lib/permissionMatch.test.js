import test from 'node:test';
import assert from 'node:assert/strict';
import { hasPerm } from './permissionMatch.js';

const DEPT = 'dept-1';
const OTHER_DEPT = 'dept-2';
const ENTITY = 'ent-1';
const BRANCH = 'br-1';
const ZONE = 'zone-1';
const ME = 'emp-me';

const deptHead = [{ permission: 'employee.create', scope_type: 'department', scope_id: DEPT }];
const entityHr = [{ permission: 'employee.create', scope_type: 'entity', scope_id: ENTITY }];

test('a department-scoped grant matches its own department', () => {
  assert.equal(hasPerm(deptHead, 'employee.create', { entityId: ENTITY, deptId: DEPT }), true);
});

test('a department-scoped grant does NOT match another department', () => {
  assert.equal(hasPerm(deptHead, 'employee.create', { entityId: ENTITY, deptId: OTHER_DEPT }), false);
});

test('a department-scoped grant does NOT match a row with no department', () => {
  // The bug this file exists for: has_perm compares scope_id = NULL, which is NULL, not true. A
  // naive === would return true here (null === null) and the UI would offer an insert that RLS
  // then refuses with a raw Postgres error.
  assert.equal(hasPerm(deptHead, 'employee.create', { entityId: ENTITY, deptId: null }), false);
});

test('an entity-scoped grant matches a row with no department', () => {
  // Confirmed against the live policy: hr_manager@entity may create an employee with no department.
  assert.equal(hasPerm(entityHr, 'employee.create', { entityId: ENTITY, deptId: null }), true);
});

test('an entity-scoped grant does not reach another entity', () => {
  assert.equal(hasPerm(entityHr, 'employee.create', { entityId: 'ent-2', deptId: DEPT }), false);
});

test('a branch grant needs the branch, a zone grant needs the zone', () => {
  const branchMgr = [{ permission: 'employee.create', scope_type: 'branch', scope_id: BRANCH }];
  const zonalMgr = [{ permission: 'employee.create', scope_type: 'zone', scope_id: ZONE }];
  assert.equal(hasPerm(branchMgr, 'employee.create', { branchId: BRANCH }), true);
  assert.equal(hasPerm(branchMgr, 'employee.create', { branchId: null }), false);
  assert.equal(hasPerm(zonalMgr, 'employee.create', { zoneId: ZONE }), true);
  assert.equal(hasPerm(zonalMgr, 'employee.create', { zoneId: null }), false);
});

test('global matches anything, including a row with no ancestry at all', () => {
  const global = [{ permission: 'employee.create', scope_type: 'global', scope_id: null }];
  assert.equal(hasPerm(global, 'employee.create', {}), true);
});

test('a super admin matches everything without consulting the list', () => {
  assert.equal(hasPerm([], 'anything.at.all', {}, { isSuperAdmin: true }), true);
});

test("a self grant matches only the signed-in person's own record", () => {
  const self = [{ permission: 'leave.create', scope_type: 'self', scope_id: null }];
  assert.equal(hasPerm(self, 'leave.create', { employeeId: ME }, { myEmployeeId: ME }), true);
  assert.equal(hasPerm(self, 'leave.create', { employeeId: 'someone-else' }, { myEmployeeId: ME }), false);
  // Not a licence to create unattached rows.
  assert.equal(hasPerm(self, 'leave.create', { employeeId: null }, { myEmployeeId: ME }), false);
  assert.equal(hasPerm(self, 'leave.create', { employeeId: null }, { myEmployeeId: null }), false);
});

test('a different permission never matches', () => {
  assert.equal(hasPerm(deptHead, 'payroll.manage', { deptId: DEPT }), false);
});

test('an empty or missing list denies', () => {
  assert.equal(hasPerm([], 'employee.create', { deptId: DEPT }), false);
  assert.equal(hasPerm(null, 'employee.create', { deptId: DEPT }), false);
  assert.equal(hasPerm(undefined, 'employee.create', { deptId: DEPT }), false);
});
