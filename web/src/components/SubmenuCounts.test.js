import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let server, Attendance, WorkLedger, AuthContext;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  ({ default: Attendance } = await server.ssrLoadModule('/src/components/Attendance.jsx'));
  ({ default: WorkLedger } = await server.ssrLoadModule('/src/components/WorkLedger.jsx'));
});
after(async () => { await server?.close(); });

const counts = { tasks: 127, task_requests: 2, task_routine: 5, attendance: 3, leave: 4, expense: 7, helpdesk: 2 };
const auth = {
  user: { id: 'submenu-user' }, employee: { id: 'submenu-employee', full_name: 'Test Person' },
  isSuperAdmin: true, assignments: [], permissions: [],
};

function renderPage({ path = '/attendance/today', data = counts, error = false, actor = auth, requests = [] } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: {
    enabled: false, retry: false, retryOnMount: false, staleTime: Infinity, gcTime: 0,
  } } });
  const key = ['section-counts', actor.user.id, false, 'navigation-v2'];
  if (data !== null) client.setQueryData(key, data);
  if (error) client.getQueryCache().build(client, { queryKey: key }).setState({
    status: 'error', fetchStatus: 'idle', error: new Error('Fixture unavailable'),
  });
  client.setQueryData(['my-departments'], [{ id: 'my-department', name: 'My department' }]);
  client.setQueryData(['help-requests'], requests);
  const Component = path.startsWith('/ledger') ? WorkLedger : Attendance;
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(AuthContext.Provider, { value: actor },
        React.createElement(MemoryRouter, { initialEntries: [path] }, React.createElement(Component)))));
  } finally { client.clear(); }
}

function submenuButton(html, label) {
  const button = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
    .map(match => match[0])
    .find(markup => markup.replace(/<[^>]*>/g, '').trim().startsWith(label));
  assert.ok(button, `${label} submenu is present`);
  return button;
}

test('attendance identifies the review submenu while it is inactive and after opening it', () => {
  for (const path of ['/attendance/today', '/attendance/regularizations']) {
    const html = renderPage({ path });
    const button = submenuButton(html, 'Regularizations');
    assert.match(button, /aria-label="Regularizations, 3 attendance requests to review"/);
    assert.match(button, /class="count-badge/);
    assert.match(button, />3<\/span>/);
    if (path.endsWith('/regularizations')) assert.match(button, /aria-current="page"/);
    else assert.doesNotMatch(button, /aria-current=/);
    for (const label of ['Today', 'Exceptions']) {
      assert.doesNotMatch(submenuButton(html, label), /class="count-badge/);
    }
  }
});

test('Work Ledger tabs show their distinct action queues on active and inactive tabs', () => {
  for (const path of ['/ledger/team', '/ledger/home']) {
    const html = renderPage({ path });
    const button = submenuButton(html, 'Home');
    assert.match(button, /aria-label="Home, 127 tasks to complete"/);
    assert.match(button, />99\+<\/span>/);
    assert.match(button, path.endsWith('/home') ? /aria-selected="true"/ : /aria-selected="false"/);
    assert.doesNotMatch(submenuButton(html, 'Team'), /class="count-badge/);
    assert.match(submenuButton(html, 'Requests'), /aria-label="Requests, 2 requests to review"/);
    assert.match(submenuButton(html, 'Routines'), /aria-label="Routines, 5 routine jobs to complete today"/);
  }
});

test('nested counts retain cached values after a refresh failure and hide unknown or empty counts', () => {
  for (const [path, label, countLabel] of [
    ['/attendance/regularizations', 'Regularizations', '3 attendance requests to review'],
    ['/ledger/home', 'Home', '127 tasks to complete'],
  ]) {
    const cached = submenuButton(renderPage({ path, error: true }), label);
    assert.ok(cached.includes(`aria-label="${label}, ${countLabel}"`));
    for (const options of [
      { data: null },
      { data: null, error: true },
      { data: { ...counts, attendance: 0, tasks: 0 } },
    ]) {
      const button = submenuButton(renderPage({ path, ...options }), label);
      assert.doesNotMatch(button, /class="count-badge/);
      assert.doesNotMatch(button, /aria-label="[^"]+, \d/);
    }
  }
});

test('attendance review badges are absent for viewers who cannot approve requests', () => {
  for (const scope_type of ['global', 'self']) {
    const actor = { ...auth, isSuperAdmin: false,
      permissions: [{ permission: 'attendance.read', scope_type, scope_id: null }],
    };
    const label = scope_type === 'self' ? 'Fix attendance' : 'Regularizations';
    const html = renderPage({ actor, path: '/attendance/regularizations' });
    const button = submenuButton(html, label);
    assert.doesNotMatch(button, /class="count-badge|attendance requests? to review/);
  }
});

test('request review counts use the shared queue instead of filtered or stale local rows', () => {
  const html = renderPage({ path: '/ledger/team', requests: [] });
  assert.match(submenuButton(html, 'Home'), /aria-label="Home, 127 tasks to complete"/);
  const button = submenuButton(html, 'Requests');
  assert.match(button, /aria-label="Requests, 2 requests to review"/);
  assert.match(button, />2<\/span>/);
});

test('legacy summaries retain a loaded incoming-request count without counting outgoing or settled work', () => {
  const requests = [
    { id: 'incoming-1', status: 'Pending', to_department_id: 'my-department', from_department_id: 'other' },
    { id: 'incoming-2', status: 'Pending', to_department_id: 'my-department', from_department_id: 'other' },
    { id: 'outgoing', status: 'Pending', to_department_id: 'other', from_department_id: 'my-department' },
    { id: 'accepted', status: 'Accepted', to_department_id: 'my-department', from_department_id: 'other' },
  ];
  const { task_requests: _requests, task_routine: _routine, ...legacyCounts } = counts;
  const html = renderPage({ path: '/ledger/team', data: legacyCounts, requests });
  assert.match(submenuButton(html, 'Home'), /aria-label="Home, 127 tasks to complete"/);
  const button = submenuButton(html, 'Requests');
  assert.match(button, /aria-label="Requests, 2 requests to review"/);
  assert.match(button, />2<\/span>/);
});

test('routine count continues through the nested My routines view while oversight views stay unbadged', () => {
  for (const path of ['/ledger/routines', '/ledger/routines?routineView=team', '/ledger/routines?routineView=manage']) {
    const html = renderPage({ path });
    for (const label of ['Routines', 'My routines']) {
      const button = submenuButton(html, label);
      assert.ok(button.includes(`aria-label="${label}, 5 routine jobs to complete today"`));
      assert.match(button, />5<\/span>/);
    }
    for (const label of ['Team overview', 'Manage routines']) {
      assert.doesNotMatch(submenuButton(html, label), /class="count-badge/);
    }
  }
});

test('supplemental queues hide empty or unknown counts and retain cached counts on refresh failure', () => {
  const cached = renderPage({ path: '/ledger/routines', error: true });
  assert.match(submenuButton(cached, 'Requests'), /aria-label="Requests, 2 requests to review"/);
  assert.match(submenuButton(cached, 'My routines'), /aria-label="My routines, 5 routine jobs to complete today"/);
  for (const value of [0, null, -1, '5']) {
    const html = renderPage({ path: '/ledger/routines', data: { ...counts, task_requests: value, task_routine: value } });
    for (const label of ['Requests', 'Routines', 'My routines']) {
      assert.doesNotMatch(submenuButton(html, label), /class="count-badge|aria-label="[^"]+, \d/);
    }
    assert.match(submenuButton(html, 'Home'), /aria-label="Home, 127 tasks to complete"/);
  }
});

test('employee task views show personal queues without management submenus', () => {
  const actor = { ...auth, isSuperAdmin: false, assignments: [{ role: 'employee', scope_type: 'self' }],
    permissions: ['task.read', 'task.update'].map(permission => ({ permission, scope_type: 'self', scope_id: null })),
  };
  const html = renderPage({ actor, path: '/ledger/routines', data: { ...counts, task_requests: 0 } });
  assert.match(submenuButton(html, 'My routines'), /aria-label="My routines, 5 routine jobs to complete today"/);
  assert.match(submenuButton(html, 'Home'), /aria-label="Home, 127 tasks to complete"/);
  assert.doesNotMatch(html, /aria-label="Requests|id="ledger-tab-team"|>Team overview<|>Manage routines</);
});
