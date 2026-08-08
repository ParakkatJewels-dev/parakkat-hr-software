import test from 'node:test';
import assert from 'node:assert/strict';
import { grantableRoles, maxGrantableRank } from './roleGrants.js';

const keys = (myRank, myRoles) => grantableRoles(myRank, myRoles).map((r) => r.key);

// The report this exists to answer: "why should an HR assign an employee a zonal manager role".
test('HR hands out employees and department heads, and nothing that appoints a manager', () => {
  assert.deepEqual(keys(60, ['hr_manager']), ['employee', 'dept_head']);
});

test('everyone else keeps the strictly-below rule from 0044', () => {
  assert.deepEqual(keys(80, ['entity_admin']), ['employee', 'dept_head', 'branch_manager', 'zonal_manager', 'hr_manager']);
  assert.deepEqual(keys(40, ['branch_manager']), ['employee', 'dept_head']);
  assert.deepEqual(keys(30, ['dept_head']), ['employee']);
});

test('a role may not mint itself — the lateral escalation 0044 was written for', () => {
  assert.ok(!keys(40, ['branch_manager']).includes('branch_manager'));
  assert.ok(!keys(80, ['entity_admin']).includes('entity_admin'));
});

// The HR cap is about what HR alone may do. Wearing the hat as well as a bigger one must not
// demote somebody to it.
test('the most generous role held wins, so an admin who is also HR is still an admin', () => {
  assert.equal(maxGrantableRank(80, ['hr_manager', 'entity_admin']), 79);
  assert.ok(keys(80, ['hr_manager', 'entity_admin']).includes('zonal_manager'));
});

// Everybody senior is also an employee somewhere in the data. That extra role carries a lower
// ceiling and must not raise HR's, nor drop it back to the seniority rule.
test('also holding the employee role neither raises nor bypasses the HR cap', () => {
  assert.deepEqual(keys(60, ['hr_manager', 'employee']), ['employee', 'dept_head']);
});

test('also holding zonal authority does not bypass the HR cap while HR is the highest role', () => {
  assert.equal(maxGrantableRank(60, ['hr_manager', 'zonal_manager']), 30);
  assert.deepEqual(keys(60, ['hr_manager', 'zonal_manager']), ['employee', 'dept_head']);
  assert.deepEqual(keys(60, [
    { role: 'hr_manager', rank: 60 },
    { role: 'zonal_manager', rank: 50 },
    { role: 'employee', rank: 10 },
  ]), ['employee', 'dept_head']);
});

test('rank-bearing custom roles do not turn the HR cap into a seniority fallback', () => {
  assert.deepEqual(keys(60, [
    { role: 'hr_manager', rank: 60 },
    { role: 'custom_helper', rank: 20 },
  ]), ['employee', 'dept_head']);
});

test('a role this module does not know falls back to the rank the database gave us', () => {
  // super_admin is not a preset — it is never offered, and it is not in RANK_BY_ROLE.
  assert.equal(maxGrantableRank(1000, ['super_admin']), 999);
  assert.equal(maxGrantableRank(60, []), 59);
});

test('nobody is ever offered super_admin, whatever they hold', () => {
  assert.ok(!keys(1000, ['super_admin']).includes('super_admin'));
});

// The hole seniority-always-speaks closes: a super admin's rank comes from the flag, not from an
// assignment, and their one visible assignment is often the auto-granted employee@self. Reading
// the ceiling off held roles alone demoted them to an employee's ceiling — zero offerable roles.
test('a super admin holding only the auto-granted employee@self role keeps their full ceiling', () => {
  assert.equal(maxGrantableRank(1000, ['employee']), 999);
  assert.deepEqual(
    keys(1000, ['employee']),
    ['employee', 'dept_head', 'branch_manager', 'zonal_manager', 'hr_manager', 'entity_admin']
  );
});
