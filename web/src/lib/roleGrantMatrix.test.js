// The Give access panel's rules against the database's own answers. role-grant-matrix.json is
// written by backend/scripts/testRoleMatrix.js from 720 real, rolled-back grant attempts (every
// standard role giving every role, at every area, inside and outside their company). If a migration
// changes who may give what, this test fails until the panel says the same thing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { areaLevelsFor, grantableRoles, lockedRoles } from './roleGrants.js';

const matrix = JSON.parse(await readFile(new URL('../../backend/tests/fixtures/role-grant-matrix.json', import.meta.url), 'utf8'));
// The two custom roles the database test creates, as useRoles() would return them.
const catalogue = [
  { key: 'audit_custom_basic', name: 'Audit custom basic', rank: matrix.ranks.audit_custom_basic, is_system: false, permissionKeys: ['attendance.read'] },
  { key: 'audit_custom_admin', name: 'Audit custom admin', rank: matrix.ranks.audit_custom_admin, is_system: false, permissionKeys: ['rbac.manage'] },
];
// The rank the app sees: a super admin's comes from the flag (1000), everyone else's from their role.
const appRank = (granter) => (granter.key === 'super_admin' ? 1000 : granter.rank);
// Granting needs user-access authority (rbac.manage) as well; these roles have it.
const ADMINS = ['super_admin', 'entity_admin', 'hr_manager'];

function databaseAllows(granter) {
  return new Set(matrix.results
    .filter((r) => r.granter === granter && r.allowed && r.place !== 'other_company' && r.role !== 'super_admin')
    .map((r) => `${r.role}@${r.level}`));
}
function panelOffers(granter) {
  const roles = grantableRoles(appRank(granter), [{ role: granter.key }], catalogue);
  return new Set(roles.flatMap((role) => areaLevelsFor(role.key, { isSuperAdmin: granter.key === 'super_admin' })
    .map((level) => `${role.key}@${level.scopeType}`)));
}

test('the matrix covers every standard granter, every role and every area', () => {
  assert.equal(matrix.results.length, 720);
  assert.deepEqual(new Set(matrix.granters.map((g) => g.key)),
    new Set(['super_admin', 'entity_admin', 'hr_manager', 'zonal_manager', 'branch_manager', 'dept_head', 'employee', 'unassigned']));
});

for (const key of ADMINS) {
  test(`${key}: the panel offers exactly the roles and areas the database allows`, () => {
    const granter = matrix.granters.find((g) => g.key === key);
    assert.deepEqual([...panelOffers(granter)].sort(), [...databaseAllows(key)].sort());
  });
}

test('managers without user-access authority can give nothing, so they never see the panel', () => {
  for (const key of ['zonal_manager', 'branch_manager', 'dept_head', 'employee', 'unassigned']) {
    assert.equal(databaseAllows(key).size, 0, key);
  }
});

test('every role the panel locks is one the database refuses', () => {
  for (const key of ADMINS) {
    const granter = matrix.granters.find((g) => g.key === key);
    const allowedRoles = new Set([...databaseAllows(key)].map((pair) => pair.split('@')[0]));
    for (const role of lockedRoles(appRank(granter), [{ role: key }], catalogue)) {
      assert.ok(!allowedRoles.has(role.key), `${key} is shown ${role.key} as locked, but the database allows it`);
    }
  }
});

test('nobody but a super admin gives access in another company', () => {
  const crossCompany = matrix.results.filter((r) => r.place === 'other_company' && r.allowed);
  assert.ok(crossCompany.length > 0 && crossCompany.every((r) => r.granter === 'super_admin'));
});
