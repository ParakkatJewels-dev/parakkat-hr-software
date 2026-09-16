import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';
import { navigationScreenCount } from '../../lib/navigationCounts.js';

let server, CountBadge, LiquidGlassNav, App, AuthContext, originalWindow, originalStorage;
let collapsed = false;
before(async () => {
  originalWindow = globalThis.window;
  originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = { getItem: key => key === 'sidebar-collapsed' && collapsed ? 'true' : null, setItem() {}, removeItem() {} };
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ default: CountBadge } = await server.ssrLoadModule('/src/components/ui/CountBadge.jsx'));
  ({ default: LiquidGlassNav } = await server.ssrLoadModule('/src/components/ui/LiquidGlassNav.jsx'));
  ({ default: App } = await server.ssrLoadModule('/src/App.jsx'));
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  globalThis.localStorage = storage;
  globalThis.window = { localStorage: storage, navigator: { standalone: false }, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} };
});
after(async () => {
  if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
  if (originalStorage === undefined) delete globalThis.localStorage; else Object.defineProperty(globalThis, 'localStorage', originalStorage);
  await server?.close();
});

const counts = { tasks: 127, leave: 4, expense: 7, attendance: 3, helpdesk: 2 };
const auth = {
  user: { id: 'badge-user', email: 'badge@example.test' }, employee: { id: 'badge-self', full_name: 'Test Person' },
  isSuperAdmin: true, assignments: [], permissions: [], hiddenScreens: [], signOut() {},
};
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
function renderApp({ data = counts, error = false, actor = auth, path = '/attendance' } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity, gcTime: 0 } } });
  const key = ['section-counts', actor.user.id, false];
  if (data !== null) client.setQueryData(key, data);
  if (error) client.getQueryCache().build(client, { queryKey: key }).setState({ status: 'error', fetchStatus: 'idle', error: new Error('Fixture unavailable') });
  client.setQueryData(['message-delivery', actor.employee.id], [{ id: 'chat', unread_count: 205 }, { id: 'declined', unread_count: 9, request_status: 'declined' }]);
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(AuthContext.Provider, { value: actor },
        React.createElement(MemoryRouter, { initialEntries: [path] }, React.createElement(App)))));
  } finally { client.clear(); }
}

test('CountBadge caps visual numbers while exposing the exact singular or plural count', () => {
  const large = render(CountBadge, { count: 127, singular: 'task to complete', plural: 'tasks to complete' });
  assert.match(large, /aria-label="127 tasks to complete"/);
  assert.match(large, />99\+<\/span>/);
  assert.match(render(CountBadge, { count: 1 }), /aria-label="1 item needing action"/);
  for (const count of [0, undefined, null, -1, NaN, Infinity, '5']) assert.equal(render(CountBadge, { count }), '');
  const decorative = render(CountBadge, { count: 127, decorative: true, corner: true });
  assert.match(decorative, /aria-hidden="true"/);
  assert.doesNotMatch(decorative, /aria-label=/);
  assert.match(decorative, /count-badge-corner/);
});

test('LiquidGlassNav exposes exact action and unread counts without changing current-page semantics', () => {
  const items = [
    { id: 'tasks', label: 'Tasks', badge: navigationScreenCount('tasks', counts) },
    { id: 'messages', label: 'Chat', badge: navigationScreenCount('messages', counts, 205) },
    { id: 'attendance', label: 'Time', badge: navigationScreenCount('attendance', counts) },
  ];
  const html = render(LiquidGlassNav, { items, activeId: 'tasks', onSelect() {} });
  assert.match(html, /aria-label="Tasks, 127 tasks to complete" aria-current="page"/);
  assert.match(html, /aria-label="Chat, 205 unread messages"/);
  assert.match(html, /aria-label="Time, 3 attendance requests to review"/);
  assert.equal((html.match(/>99\+<\/span>/g) ?? []).length, 2);
  assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
  const empty = render(LiquidGlassNav, { items: [{ id: 'tasks', label: 'Tasks', badge: navigationScreenCount('tasks', {}) }], activeId: '', onSelect() {} });
  assert.match(empty, /aria-label="Tasks"/);
  assert.doesNotMatch(empty, /class="count-badge/);
});

test('expanded and collapsed sidebars show visible section totals, tab counts, and unread messages', () => {
  for (const value of [false, true]) {
    collapsed = value;
    const html = renderApp();
    assert.match(html, /aria-label="Time &amp; Attendance, 7 items needing action"/);
    assert.match(html, /aria-label="Work, 127 items needing action"/);
    assert.match(html, /aria-label="Support, 2 unresolved tickets"/);
    assert.match(html, /aria-label="Attendance, 3 attendance requests to review"/);
    assert.match(html, /aria-label="Leave, 4 leave requests to review"/);
    assert.match(html, /aria-label="Messages, 205 unread messages"/);
    assert.match(html, /aria-label="Chat, 205 unread messages"/);
    if (value) assert.match(html, /title="Work, 127 items needing action"/);
  }
  collapsed = false;
});

test('a failed count refresh retains cached counts and an initial failure does not invent empty queues', () => {
  const stale = renderApp({ error: true });
  assert.match(stale, /aria-label="Work, 127 items needing action"/);
  assert.match(stale, /Showing the last available counts/);
  const unknown = renderApp({ data: null, error: true });
  assert.match(unknown, /Section counts are unavailable/);
  assert.doesNotMatch(unknown, /aria-label="(?:Work|Time &amp; Attendance|Support), [0-9]/);
  assert.doesNotMatch(unknown, /class="count-badge/);
  assert.match(unknown, /aria-label="Messages, 205 unread messages"/, 'an unrelated summary error does not discard inbox counts');
});

test('real employees keep their granted support count and hidden screens do not contribute to sections', () => {
  const employee = { ...auth, isSuperAdmin: false, assignments: [{ role: 'employee', scope_type: 'self' }],
    permissions: ['task.read', 'attendance.read', 'ticket.read', 'ticket.manage'].map(permission => ({ permission, scope_type: 'self', scope_id: null })) };
  const own = renderApp({ actor: employee, path: '/not-a-page' });
  assert.match(own, /aria-label="My Tasks, 127 tasks to complete"/);
  assert.match(own, /aria-label="Help &amp; Support, 2 unresolved tickets"/);
  const manager = { ...auth, isSuperAdmin: false, assignments: [{ role: 'entity_admin', scope_type: 'entity', scope_id: 'entity' }],
    permissions: ['attendance.read', 'leave.read', 'device.manage'].map(permission => ({ permission, scope_type: 'entity', scope_id: 'entity' })), hiddenScreens: ['leave'] };
  const hidden = renderApp({ actor: manager });
  assert.match(hidden, /aria-label="Time &amp; Attendance, 3 items needing action"/);
  assert.doesNotMatch(hidden, /aria-label="Leave, 4 leave requests to review"/);
});
