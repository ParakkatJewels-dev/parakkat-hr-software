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

test('custom roles from the catalogue are offered under the same ceilings as built-in ones', () => {
  const catalogue = [
    { key: 'employee', name: 'Employee', rank: 10, is_system: true, permissionKeys: [] },
    { key: 'super_admin', name: 'Super Admin', rank: 100, is_system: true, permissionKeys: ['rbac.manage'] },
    { key: 'store_supervisor', name: 'Store Supervisor', rank: 20, is_system: false, description: 'Opens and closes the store', permissionKeys: ['attendance.read'] },
    { key: 'it_admin', name: 'IT Admin', rank: 20, is_system: false, permissionKeys: ['rbac.manage'] },
    { key: 'regional_lead', name: 'Regional Lead', rank: 70, is_system: false, permissionKeys: ['leave.approve'] },
  ];
  const offered = (myRank, myRoles) => grantableRoles(myRank, myRoles, catalogue).map((r) => r.key);
  // A super admin sees every custom role, after the built-in ones.
  const admin = grantableRoles(1000, [{ role: 'employee' }], catalogue);
  assert.deepEqual(admin.filter((r) => r.custom).map((r) => r.key), ['it_admin', 'regional_lead', 'store_supervisor']);
  const supervisor = admin.find((r) => r.key === 'store_supervisor');
  assert.equal(supervisor.label, 'Store Supervisor');
  assert.equal(supervisor.blurb, 'Opens and closes the store');
  assert.equal(supervisor.scopeType, 'department', 'a custom role starts at the narrowest area on the record');
  // Seniority still applies: a department head (rank 30) may hand out a rank-20 custom role, not a rank-70 one,
  // and never one that carries user or organisation administration.
  assert.ok(offered(30, [{ role: 'dept_head' }]).includes('store_supervisor'));
  assert.ok(!offered(30, [{ role: 'dept_head' }]).includes('regional_lead'));
  assert.ok(!offered(30, [{ role: 'dept_head' }]).includes('it_admin'));
  assert.ok(offered(80, [{ role: 'entity_admin' }]).includes('it_admin'), 'an entity admin may');
  // Built-ins come from the presets, never twice; super admin is never offered.
  assert.equal(offered(1000, []).filter((key) => key === 'employee').length, 1);
  assert.ok(!offered(1000, []).includes('super_admin'));
  // Without a catalogue (older callers) only the built-in roles, as before.
  assert.ok(grantableRoles(1000, []).every((r) => !r.custom));
});

test('each role offers the areas the database allows, the usual one first', async () => {
  const { areaLevelsFor } = await import('./roleGrants.js');
  const levels = (role, options) => areaLevelsFor(role, options).map((level) => level.scopeType);
  assert.deepEqual(levels('employee'), ['self']);
  assert.deepEqual(levels('dept_head'), ['department']);
  assert.deepEqual(levels('branch_manager'), ['branch']);
  assert.deepEqual(levels('zonal_manager'), ['zone']);
  assert.deepEqual(levels('hr_manager'), ['entity', 'zone', 'branch', 'department']);
  assert.deepEqual(levels('entity_admin'), ['entity']);
  assert.deepEqual(levels('super_admin'), [], 'the whole group only for a super admin');
  assert.deepEqual(levels('super_admin', { isSuperAdmin: true }), ['global']);
  assert.deepEqual(levels('store_supervisor'), ['department', 'branch', 'zone', 'entity'], 'a custom role: any area');
  assert.deepEqual(levels('store_supervisor', { isSuperAdmin: true }), ['department', 'branch', 'zone', 'entity', 'self', 'global']);
});

test('roles you cannot give are listed with the reason in plain words', async () => {
  const { lockedRoles } = await import('./roleGrants.js');
  const reasons = (rank, roles, catalogue = []) => Object.fromEntries(lockedRoles(rank, roles, catalogue).map((r) => [r.key, r.reason]));
  const hr = reasons(60, [{ role: 'hr_manager' }]);
  assert.deepEqual(Object.keys(hr), ['branch_manager', 'zonal_manager', 'hr_manager', 'entity_admin']);
  assert.ok(Object.values(hr).every((reason) => reason === 'HR can give roles up to Department Head.'));
  const head = reasons(30, [{ role: 'dept_head' }], [{ key: 'it_admin', name: 'IT Admin', rank: 20, is_system: false, permissionKeys: ['rbac.manage'] }]);
  assert.equal(head.dept_head, 'Only someone more senior than you can give this.');
  assert.equal(head.it_admin, 'It can manage users, so only a company admin can give it.');
  assert.deepEqual(lockedRoles(1000, [], []), [], 'a super admin can give everything');
});

test('places read the way people say them', async () => {
  const { placeName } = await import('./roleGrants.js');
  const org = { branches: [{ id: 'b', name: 'Kochi' }, { id: 'b2', code: 'TVM', name: null }], departments: [{ id: 'd', name: 'Sales Department' }],
    zones: [{ id: 'z', name: 'South' }], entities: [{ id: 'e', name: 'Parakkat Jewels' }] };
  assert.equal(placeName('branch', 'b', org), 'Kochi branch');
  assert.equal(placeName('branch', 'b2', org), 'TVM branch');
  assert.equal(placeName('department', 'd', org), 'Sales Department', 'no doubled noun');
  assert.equal(placeName('zone', 'z', org), 'South zone');
  assert.equal(placeName('entity', 'e', org), 'Parakkat Jewels');
  assert.equal(placeName('self', null, org), null);
});
