import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let server, AuthContext, Login, ForgotPassword, SetYourPassword, ChangePassword, Administration, ManagePasswordDialog;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  ({ default: Login } = await server.ssrLoadModule('/src/pages/Login.jsx'));
  ({ default: ForgotPassword } = await server.ssrLoadModule('/src/pages/ForgotPassword.jsx'));
  ({ default: SetYourPassword } = await server.ssrLoadModule('/src/components/SetYourPassword.jsx'));
  ({ default: ChangePassword } = await server.ssrLoadModule('/src/components/ChangePassword.jsx'));
  ({ default: Administration } = await server.ssrLoadModule('/src/components/Administration.jsx'));
  ({ default: ManagePasswordDialog } = await server.ssrLoadModule('/src/components/ManagePasswordDialog.jsx'));
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
test('super admin can manage passwords directly from collapsed account rows', () => {
  const html = render(Administration);
  for (const user of users) assert.ok(html.includes(`Manage password for ${user.email}`));
  const summaries = [...html.matchAll(/<summary\b[\s\S]*?<\/summary>/g)].map(([summary]) => summary);
  assert.equal(summaries.filter((summary) => summary.includes('Manage password for ')).length, users.length);
  assert.match(html, /Link employee/);
});
test('delegated admin sees user actions only below their rank, in their scope', () => {
  const html = render(Administration, {}, { isSuperAdmin: false, rank: 40,
    assignments: [{ role: 'branch_manager', scope_type: 'branch', scope_id: 'b1' }],
    permissions: [{ permission: 'rbac.manage', scope_type: 'branch', scope_id: 'b1' }] });
  assert.match(html, /Manage password for staff@example.test/);
  assert.match(html, /Delete the login for Sample Employee/);
  assert.doesNotMatch(html, /Manage password for senior@example.test|Delete the login for Sample Senior|Manage password for unlinked@example.test|Link employee/);
});

test('password dialog identifies the target and offers temporary and email reset options', () => {
  const html = render(ManagePasswordDialog, { target: users[0], currentUserId: 'viewer', onClose() {}, onSuccess() {} });
  assert.match(html, /role="dialog" aria-modal="true"/);
  assert.match(html, /staff@example.test/);
  for (const label of ['Set temporary password', 'Send reset email', 'Confirm temporary password', 'Show passwords', 'next sign-in', '72 bytes']) assert.ok(html.includes(label), label);
  assert.equal((html.match(/autoComplete="new-password"/g) ?? []).length, 2);
});

test('own-account password dialog offers the existing security settings and email recovery without a temporary password form', () => {
  const html = render(ManagePasswordDialog, { target: users[0], currentUserId: users[0].user_id, onClose() {}, onSuccess() {} });
  assert.match(html, /href="\/settings"/);
  assert.match(html, /Open Settings → Security to change your password/);
  assert.match(html, /Send reset email/);
  assert.doesNotMatch(html, /Set temporary password|autoComplete="new-password"/);
});

test('delegated administrators keep their own password entry while peers remain protected', () => {
  const html = render(Administration, {}, { user: { id: 'senior', email: 'senior@example.test' }, isSuperAdmin: false, rank: 60,
    assignments: [{ role: 'hr_manager', scope_type: 'branch', scope_id: 'b1' }],
    permissions: [{ permission: 'rbac.manage', scope_type: 'branch', scope_id: 'b1' }] });
  assert.match(html, /Manage password for senior@example.test/);
  assert.doesNotMatch(html, /Delete the login for Sample Senior/);
});
