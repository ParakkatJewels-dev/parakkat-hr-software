import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let server, NotificationBell, AuthContext;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  ({ default: NotificationBell } = await server.ssrLoadModule('/src/components/NotificationBell.jsx'));
});
after(async () => { await server?.close(); });

const auth = {
  user: { id: 'bell-user' }, employee: { id: 'bell-employee', full_name: 'Test Person' },
  isSuperAdmin: true, assignments: [], permissions: [],
};
const preview = Array.from({ length: 40 }, (_, i) => ({ id: `notice-${i}`, read_at: null }));

function renderBell({ count = 350, available = true, rows = preview, error = false } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: {
    enabled: false, retry: false, retryOnMount: false, staleTime: Infinity, gcTime: 0,
  } } });
  const key = ['section-counts', auth.user.id, false, 'navigation-v2'];
  if (available) client.setQueryData(key, { notifications: count });
  if (error) client.getQueryCache().build(client, { queryKey: key }).setState({
    status: 'error', fetchStatus: 'idle', error: new Error('Fixture unavailable'),
  });
  client.setQueryData(['notifications'], rows);
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(AuthContext.Provider, { value: auth }, React.createElement(NotificationBell))));
  } finally { client.clear(); }
}

test('the notification bell displays the complete inbox total beyond its 40-row preview', () => {
  const html = renderBell();
  assert.match(html, /aria-label="Notifications, 350 unread notifications"/);
  assert.match(html, /title="350 unread notifications"/);
  assert.match(html, />99\+<\/span>/);
  assert.match(html, /class="count-badge count-badge-corner"/);
  assert.doesNotMatch(html, /40 unread|>9\+<\/span>/);
});

test('notifications outside the preview remain counted even if every recent notification is read', () => {
  const html = renderBell({ count: 8, rows: preview.map(row => ({ ...row, read_at: '2026-01-01T00:00:00Z' })) });
  assert.match(html, /aria-label="Notifications, 8 unread notifications"/);
  assert.match(html, />8<\/span>/);
});

test('one unread notification uses the singular label', () => {
  assert.match(renderBell({ count: 1 }), /aria-label="Notifications, 1 unread notification"/);
});

test('zero or unavailable totals never become the partial preview unread count', () => {
  for (const count of [0, null, -1, '40', NaN]) {
    const html = renderBell({ count });
    assert.match(html, /aria-label="Notifications"/);
    assert.doesNotMatch(html, /class="count-badge|unread notifications/);
  }
});

test('a failed refresh retains the last total while an initial failure stays unknown', () => {
  assert.match(renderBell({ error: true }), /aria-label="Notifications, 350 unread notifications"/);
  const unknown = renderBell({ available: false, error: true });
  assert.match(unknown, /aria-label="Notifications"/);
  assert.doesNotMatch(unknown, /class="count-badge|40 unread/);
});
