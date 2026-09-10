import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccessLoader } from './accessLoader.js';
import { accessCacheScope, guardedStorage } from './accessCache.js';
import { passwordRecoveryRedirect, isRecoveryUrl, requestPasswordReset } from './passwordRecovery.js';
import { canManageUser, assignmentScope, hasAssignment, revokeRole, createManagedUser, refreshUserAdministration } from './adminUsers.js';

test('reset links preserve the web base path, never hash routes or old tokens', () => {
  assert.equal(passwordRecoveryRedirect('https://hr.example.com/app/?code=old#/admin/users'), 'https://hr.example.com/app/?auth=recovery');
  assert.equal(passwordRecoveryRedirect('capacitor://localhost', 'https://hr.example.com/'), 'https://hr.example.com/?auth=recovery');
  assert.throws(() => passwordRecoveryRedirect('capacitor://localhost'), /web address/);
});

test('recovery intent is distinguished from ordinary app routes', () => {
  assert.equal(isRecoveryUrl('https://hr.example.com/?auth=recovery'), true);
  assert.equal(isRecoveryUrl('https://hr.example.com/#access_token=sample&type=recovery'), true);
  assert.equal(isRecoveryUrl('https://hr.example.com/#/login'), false);
});

test('admin reset requests email the target, without updating the administrator', async () => {
  const calls = [];
  await requestPasswordReset({ resetPasswordForEmail: async (...args) => { calls.push(args); return { error: null }; },
    updateUser: () => assert.fail('must never change admin password') }, ' person@example.com ', 'https://hr.example.com/?auth=recovery');
  assert.deepEqual(calls, [['person@example.com', { redirectTo: 'https://hr.example.com/?auth=recovery' }]]);
});

test('invalid emails do not call auth; rate limits and network errors remain visible', async () => {
  await assert.rejects(requestPasswordReset({ resetPasswordForEmail: () => assert.fail() }, 'bad', 'https://hr.example.com'), /valid email/);
  await assert.rejects(requestPasswordReset({ resetPasswordForEmail: async () => ({ error: new Error('rate limited') }) }, 'a@example.com', 'https://hr.example.com'), /rate limited/);
  await assert.rejects(requestPasswordReset({ resetPasswordForEmail: async () => { throw new Error('offline'); } }, 'a@example.com', 'https://hr.example.com'), /offline/);
});

function accessHarness() {
  let state;
  const pending = [];
  const loader = createAccessLoader(() => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    (value) => { state = typeof value === 'function' ? value(state) : value; });
  return { loader, pending, state: () => state };
}

test('an old user response cannot grant access after an account switch', async () => {
  const h = accessHarness();
  h.loader.setUser('admin'); const first = h.loader.load();
  h.loader.setUser('employee'); const second = h.loader.load();
  h.pending[1].resolve({ data: { is_super_admin: false } }); await second;
  h.pending[0].resolve({ data: { is_super_admin: true } }); await first;
  assert.equal(h.state().userId, 'employee');
  assert.equal(h.state().data.is_super_admin, false);
});

test('sign-out invalidates an in-flight access request', async () => {
  const h = accessHarness(); h.loader.setUser('a'); const request = h.loader.load();
  h.loader.setUser(null); h.pending[0].resolve({ data: { is_super_admin: true } }); await request;
  assert.equal(h.state().data, null); assert.equal(h.state().loading, false);
});

test('newer permission refresh wins, even for the same user', async () => {
  const h = accessHarness(); h.loader.setUser('a'); const first = h.loader.load(); const second = h.loader.load();
  h.pending[1].resolve({ data: { permissions: [] } }); await second;
  h.pending[0].resolve({ data: { permissions: ['rbac.manage'] } }); await first;
  assert.deepEqual(h.state().data.permissions, []);
});

test('access failures fail closed and can be retried instead of spinning forever', async () => {
  const h = accessHarness(); h.loader.setUser('a'); const first = h.loader.load();
  h.pending[0].reject(new Error('offline')); await first;
  assert.equal(h.state().loading, false); assert.equal(h.state().data, null); assert.match(h.state().error.message, /offline/);
  const retry = h.loader.load(); h.pending[1].resolve({ data: { permissions: [] } }); await retry;
  assert.equal(h.state().error, null); assert.deepEqual(h.state().data.permissions, []);
});

const access = { rank: 40, permissions: [{ permission: 'rbac.manage', scope_type: 'branch', scope_id: 'b1' }] };
test('cache ownership changes with the user, permissions, employee link and hidden screens', () => {
  const key = accessCacheScope('a', access);
  assert.equal(accessCacheScope('a', null), null);
  for (const [id, value] of [['b', access], ['a', { ...access, permissions: [] }], ['a', { ...access, employee: { id: 'new' } }], ['a', { ...access, hidden_screens: ['payroll'] }]]) {
    assert.notEqual(accessCacheScope(id, value), key);
  }
});

test('equivalent unordered permissions do not unnecessarily remount the app', () => {
  const a = { ...access, hidden_screens: ['tasks', 'payroll'] };
  const b = { ...access, hidden_screens: ['payroll', 'tasks'], permissions: [{ scope_id: 'b1', scope_type: 'branch', permission: 'rbac.manage' }] };
  assert.equal(accessCacheScope('a', a), accessCacheScope('a', b));
});

test('a delayed cache write cannot restore data after its owner signed out', () => {
  let current = true;
  const writes = [];
  const storage = guardedStorage({ setItem: (...args) => writes.push(args), getItem: () => 'private', removeItem() {} }, () => current);
  storage.setItem('a', 'data'); current = false; storage.setItem('a', 'late data');
  assert.equal(writes.length, 1); assert.equal(storage.getItem('a'), null);
});

const roles = [{ key: 'employee', rank: 10 }, { key: 'hr_manager', rank: 60 }];
const employees = [{ id: 'e1', branch_id: 'b1' }, { id: 'e2', branch_id: 'b2' }];
const target = { user_id: 'u1', employee_id: 'e1', roles: [{ role_key: 'employee' }] };
const admin = { isSuperAdmin: false, myRank: 40, roles, employees, can: (perm, scope) => perm === 'rbac.manage' && scope.branchId === 'b1' };
test('delegated user actions require both lower rank and the correct employee scope', () => {
  assert.equal(canManageUser(target, admin), true);
  assert.equal(canManageUser({ ...target, employee_id: 'e2' }, admin), false);
  assert.equal(canManageUser({ ...target, employee_id: null }, admin), false);
  assert.equal(canManageUser({ ...target, roles: [{ role_key: 'hr_manager' }] }, admin), false);
  assert.equal(canManageUser({ ...target, roles: [{ role_key: 'unknown' }] }, admin), false);
  assert.equal(canManageUser({ ...target, is_super_admin: true }, admin), false);
  assert.equal(canManageUser({ ...target, roles: [{ role_key: 'super_admin' }] }, admin), false);
  assert.equal(canManageUser(target, { ...admin, myRank: 10 }), false);
  assert.equal(canManageUser({ ...target, employee_id: null }, { ...admin, isSuperAdmin: true }), true);
});

test('revoke scope follows the assignment, including department ancestry and employee self', () => {
  const org = { entities: [], zones: [], branches: [{ id: 'b1', zone_id: 'z1' }], departments: [{ id: 'd1', branch_id: 'b1', entity_id: 'org' }] };
  assert.deepEqual(assignmentScope({ scope_type: 'department', scope_id: 'd1' }, target, employees, org),
    { entityId: 'org', zoneId: 'z1', branchId: 'b1', deptId: 'd1' });
  assert.equal(assignmentScope({ scope_type: 'self' }, target, employees, org).branchId, 'b1');
  assert.equal(assignmentScope({ scope_type: 'self' }, { ...target, employee_id: null }, employees, org), null);
  assert.equal(assignmentScope({ scope_type: 'global' }, target, employees, org), null);
});

test('duplicate assignments compare role AND scope, normalizing empty scope IDs', () => {
  const grants = [{ role_key: 'employee', scope_type: 'self', scope_id: null }];
  assert.equal(hasAssignment(grants, 'employee', 'self', ''), true);
  assert.equal(hasAssignment(grants, 'employee', 'branch', 'b1'), false);
});

function fakeDelete(result) {
  return { from: (table) => { assert.equal(table, 'role_assignments'); return { delete: () => ({ eq: () => ({ select: async () => result }) }) }; } };
}
test('an RLS-filtered zero-row revoke is not reported as success', async () => {
  await assert.rejects(revokeRole(fakeDelete({ data: [], error: null }), 'a'), /not removed/);
  await assert.rejects(revokeRole(fakeDelete({ error: new Error('denied') }), 'a'), /denied/);
  await revokeRole(fakeDelete({ data: [{ id: 'a' }] }), 'a');
});

test('user creation and optional employee linking use exactly one atomic RPC', async () => {
  const calls = [];
  const result = await createManagedUser({ rpc: async (...args) => { calls.push(args); return { data: 'new-user' }; } },
    { email: ' person@example.com ', password: 'temporary', employee_id: 'e1' });
  assert.deepEqual(calls, [['admin_create_user_with_employee', {
    _email: 'person@example.com', _password: 'temporary', _employee: 'e1', _super_admin: false,
  }]]);
  assert.equal(result.user_id, 'new-user');
});

test('missing atomic RPC tells the administrator to migrate, never falls back to partial creation', async () => {
  let calls = 0;
  await assert.rejects(createManagedUser({ rpc: async () => { calls++; return { error: { code: 'PGRST202' } }; } },
    { email: 'a@example.com', password: 'temporary' }), /0120_user_account_integrity.sql/);
  assert.equal(calls, 1);
});

test('role and employee-link changes refresh both user and role views', async () => {
  const keys = [];
  await refreshUserAdministration({ invalidateQueries: async ({ queryKey }) => keys.push(queryKey[0]) });
  for (const key of ['managed-users', 'employees', 'roles', 'roles-with-perms']) assert.ok(keys.includes(key));
});
