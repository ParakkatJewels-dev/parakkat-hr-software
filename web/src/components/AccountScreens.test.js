import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let server, AuthContext, Login, ForgotPassword, SetYourPassword, ChangePassword, Administration;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  ({ default: Login } = await server.ssrLoadModule('/src/pages/Login.jsx'));
  ({ default: ForgotPassword } = await server.ssrLoadModule('/src/pages/ForgotPassword.jsx'));
  ({ default: SetYourPassword } = await server.ssrLoadModule('/src/components/SetYourPassword.jsx'));
  ({ default: ChangePassword } = await server.ssrLoadModule('/src/components/ChangePassword.jsx'));
  ({ default: Administration } = await server.ssrLoadModule('/src/components/Administration.jsx'));
});
after(async () => { await server?.close(); });

const roles = [
  { id: 'employee-role', key: 'employee', name: 'Employee', rank: 10, is_system: true, permissionKeys: [] },
  { id: 'hr-role', key: 'hr_manager', name: 'HR Manager', rank: 60, is_system: true, permissionKeys: [] },
];
const users = [
  { user_id: 'staff', email: 'staff@example.test', employee_id: 'e1', employee_name: 'Sample Employee', roles: [{ assignment_id: 'a1', role_key: 'employee', scope_type: 'self' }] },
  { user_id: 'senior', email: 'senior@example.test', employee_id: 'e2', employee_name: 'Sample Senior', roles: [{ assignment_id: 'a2', role_key: 'hr_manager', scope_type: 'branch', scope_id: 'b1' }] },
  { user_id: 'unlinked', email: 'unlinked@example.test', roles: [] },
];
const employees = [{ id: 'e1', user_id: 'staff', entity_id: 'org1', branch_id: 'b1' }, { id: 'e2', user_id: 'senior', entity_id: 'org1', branch_id: 'b1' }];
const auth = {
  user: { id: 'viewer', email: 'viewer@example.test' }, employee: null, isSuperAdmin: true,
  assignments: [], permissions: [], rank: 1000, signIn() {}, signOut() {}, reloadAccess() {},
};
function render(Component, props = {}, authChanges = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['managed-users'], users);
  client.setQueryData(['roles'], roles);
  client.setQueryData(['employees'], employees);
  client.setQueryData(['org', 'all'], { entities: [{ id: 'org1', code: 'TEST', name: 'Sample Company' }],
    branches: [{ id: 'b1', entity_id: 'org1', code: 'B1' }], zones: [], departments: [], designations: [] });
  const html = renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
    React.createElement(AuthContext.Provider, { value: { ...auth, ...authChanges } },
      React.createElement(MemoryRouter, null, React.createElement(Component, props)))));
  client.clear();
  return html;
}

test('login exposes a navigable Forgot password link', () => {
  assert.match(render(Login), /href="\/forgot-password"[^>]*>Forgot password\?/);
});
test('forgot-password form has an email field, submit and sign-in return path', () => {
  const html = render(ForgotPassword);
  assert.match(html, /type="email"/); assert.match(html, /Send reset link/); assert.match(html, /Back to sign in/);
});
test('recovery form identifies the account and is not confused with a temporary-password prompt', () => {
  const html = render(SetYourPassword, { recovery: true });
  assert.match(html, /Reset your password/); assert.match(html, /viewer@example.test/);
  assert.doesNotMatch(html, /signed in with a temporary password/);
  assert.match(html, /autoComplete="new-password"/);
});
test('forced and voluntary changes display the same password rules', () => {
  for (const Component of [SetYourPassword, ChangePassword]) {
    const html = render(Component);
    for (const label of ['At least 8 characters', 'Not your own name', 'Not only numbers']) assert.ok(html.includes(label));
  }
});
test('super admin sees a reset action on every account and a link action on unlinked accounts', () => {
  const html = render(Administration);
  for (const user of users) assert.ok(html.includes(`Send password reset to ${user.email}`));
  assert.match(html, /Link employee/);
});
test('delegated admin sees user actions only below their rank, in their scope', () => {
  const html = render(Administration, {}, { isSuperAdmin: false, rank: 40,
    assignments: [{ role: 'branch_manager', scope_type: 'branch', scope_id: 'b1' }],
    permissions: [{ permission: 'rbac.manage', scope_type: 'branch', scope_id: 'b1' }] });
  assert.match(html, /Send password reset to staff@example.test/);
  assert.match(html, /Delete the login for Sample Employee/);
  assert.doesNotMatch(html, /Send password reset to senior@example.test|Delete the login for Sample Senior|Send password reset to unlinked@example.test|Link employee/);
});
