import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let server, AuthContext, UserProfile, ProfileMenuHeader;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  ({ default: UserProfile, ProfileMenuHeader } = await server.ssrLoadModule('/src/components/UserProfile.jsx'));
});
after(async () => { await server?.close(); });

const employee = { id: 'self', full_name: 'Sample Employee', employee_code: 'EMP001', phone: '9876543210' };
function render({ record = employee, linked = true, error = null, loading = false, menuOpen = false } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } } });
  if (error) client.getQueryCache().build(client, { queryKey: ['employee', 'self'] }).setState({ status: 'error', error, fetchStatus: 'idle' });
  else if (!loading) client.setQueryData(['employee', 'self'], record);
  client.setQueryData(['employee-avatars', ['self']], {});
  client.setQueryData(['assets', 'employee', 'self'], []);
  const auth = { user: { id: 'account', email: 'sample@example.test' }, employee: linked ? employee : null };
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(AuthContext.Provider, { value: auth }, React.createElement(UserProfile, {
        onOpenMenu() {}, onOpenSettings() {}, menuOpen,
      }))));
  } finally { client.clear(); }
}

function assertMenu(html, expanded = false) {
  assert.match(html, /aria-label="Open profile menu"/);
  assert.match(html, /aria-controls="mobile-navigation"/);
  assert.ok(html.includes(`aria-expanded="${expanded}"`));
}

test('profile menu invokes the application menu and exposes its current dialog state', () => {
  let opened = 0;
  const header = ProfileMenuHeader({ onOpenMenu: () => { opened += 1; }, menuOpen: true });
  const button = React.Children.toArray(header.props.children).find(child => child.type === 'button');
  assert.equal(button.props['aria-haspopup'], 'dialog');
  button.props.onClick();
  assert.equal(opened, 1);
  assertMenu(renderToStaticMarkup(header), true);
});

test('loaded profile keeps the menu, identity, editable phone and detailed HR information', () => {
  const html = render({ record: { ...employee, emergency_name: 'Emergency Contact', emergency_phone: '9876500000', personal_email: 'personal@example.test', department: { name: 'Operations' } } });
  assertMenu(html);
  for (const detail of ['Sample Employee', 'EMP001', 'Your phone number', 'Emergency Contact', 'personal@example.test', 'Operations', 'Password and display settings']) {
    assert.ok(html.includes(detail), `Missing profile detail: ${detail}`);
  }
});

test('loading employee details never hides the full-menu entry', () => {
  const html = render({ loading: true });
  assert.match(html, /aria-label="Loading profile"/);
  assertMenu(html);
});

test('failed employee details retain a usable menu and basic account information', () => {
  const html = render({ error: new Error('Fixture unavailable') });
  assert.match(html, /Some details could not be loaded/);
  assert.match(html, /Sample Employee/);
  assertMenu(html);
});

test('an unlinked administrator can open the menu without an employee record', () => {
  const html = render({ linked: false, menuOpen: true });
  assert.match(html, /not linked to an employee record/);
  assert.match(html, /sample@example.test/);
  assert.doesNotMatch(html, /aria-label="Your phone number"/);
  assertMenu(html, true);
});
