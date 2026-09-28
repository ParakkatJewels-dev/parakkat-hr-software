import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';
import { istToday } from '../lib/dates.js';
import { addDays } from '../lib/dateRange.js';

let server, AuthContext, TaskRoutine;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  ({ default: TaskRoutine } = await server.ssrLoadModule('/src/components/TaskRoutine.jsx'));
});
after(async () => { await server?.close(); });

const today = istToday();
const employee = { id: 'employee-1', entity_id: 'entity-1', full_name: 'Routine assignee', employee_code: 'E001' };
const routine = (id, overrides = {}) => ({ id, title: `Routine ${id}`, employee_id: employee.id, employee,
  frequency: 'daily', start_date: addDays(today, -10), can_manage: true,
  jobs: [{ id: `${id}-job`, title: 'Opening stock check' }], ...overrides });
const entityPermissions = ['task.read', 'task.create', 'task.manage'].map(permission => ({ permission, scope_type: 'entity', scope_id: 'entity-1' }));

function render({ auth = {}, route = '/tasks/routine', routines = [] } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, retryOnMount: false, staleTime: Infinity } } });
  for (const scope of ['all', employee.id]) {
    for (const includeRetired of [false, true]) client.setQueryData(['routine-sets', scope, includeRetired], routines);
  }
  const context = { user: { id: 'admin-user' }, employee: null, isSuperAdmin: false, assignments: [], permissions: [], ...auth };
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(AuthContext.Provider, { value: context }, React.createElement(MemoryRouter, { initialEntries: [route] }, React.createElement(TaskRoutine)))));
  } finally { client.clear(); }
}

test('super admins reach routine management by default with or without an employee profile', () => {
  for (const linkedEmployee of [null, employee]) {
    const html = render({ auth: { isSuperAdmin: true, employee: linkedEmployee }, routines: [routine('current')] });
    assert.match(html, /aria-label="Manage routine assignments"/);
    assert.match(html, /Edit routine<\/button>/);
    assert.match(html, /Add jobs<\/button>/);
    assert.match(html, /Retire routine<\/button>/);
  }
});

test('entity admins reach management using their granted scope without a super-admin override', () => {
  const html = render({ auth: { employee, assignments: [{ role: 'entity_admin', scope_type: 'entity', scope_id: 'entity-1' }], permissions: entityPermissions }, routines: [routine('current')] });
  assert.match(html, /aria-label="Manage routine assignments"/);
  assert.match(html, /Edit routine<\/button>/);
});

test('an explicit team status link stays on statistics for an administrator', () => {
  const html = render({ route: '/tasks/routine?routineView=team', auth: { isSuperAdmin: true } });
  assert.match(html, /Routine completion statistics/);
  assert.match(html, /aria-pressed="true">Statistics<\/button>/);
  assert.doesNotMatch(html, /aria-label="Manage routine assignments"/);
});

test('a linked administrator can still explicitly open their own routines', () => {
  const html = render({ route: '/tasks/routine?routineView=mine', auth: { isSuperAdmin: true, employee } });
  assert.match(html, /My routines for/);
  assert.doesNotMatch(html, /aria-label="Manage routine assignments"/);
});

test('latest retired or expired routines can be edited without needing a deleted job', () => {
  const routines = [
    routine('retired', { retired_on: addDays(today, -1) }),
    routine('expired', { end_date: addDays(today, -1) }),
    routine('once', { frequency: 'once', start_date: addDays(today, -1), end_date: addDays(today, -1) }),
  ];
  const html = render({ auth: { isSuperAdmin: true }, route: '/tasks/routine?routineView=manage', routines });
  assert.equal((html.match(/Edit routine<\/button>/g) ?? []).length, 3);
  assert.doesNotMatch(html, /Retire routine<\/button>/);
});

test('admin screens still respect server refusals and keep replaced schedule history read-only', () => {
  const routines = [routine('denied', { can_manage: false }), routine('missing-grant', { can_manage: undefined }),
    routine('historical', { replaced_by: 'latest' })];
  const html = render({ auth: { isSuperAdmin: true }, route: '/tasks/routine?routineView=manage', routines });
  assert.doesNotMatch(html, /Edit routine<\/button>|Add jobs<\/button>|Retire routine<\/button>/);
});

test('department heads keep their personal default and readers gain no management controls', () => {
  const headPermissions = ['task.read', 'task.create'].map(permission => ({ permission, scope_type: 'department', scope_id: 'dept-1' }));
  const head = render({ auth: { employee, assignments: [{ role: 'dept_head' }], permissions: headPermissions } });
  assert.match(head, /My routines for/);
  const reader = render({ auth: { employee, permissions: [{ permission: 'task.read', scope_type: 'self' }] },
    route: '/tasks/routine?routineView=manage', routines: [routine('current')] });
  assert.match(reader, /My routines for/);
  assert.doesNotMatch(reader, /Manage routines<\/button>|Edit routine<\/button>|Create routine<\/button>/);
});

test('an admin role label does not bypass missing scoped task permissions', () => {
  const html = render({ auth: { employee, assignments: [{ role: 'entity_admin', scope_type: 'entity', scope_id: 'entity-1' }],
    permissions: [{ permission: 'task.read', scope_type: 'self' }] },
  route: '/tasks/routine?routineView=manage', routines: [routine('current')] });
  assert.match(html, /My routines for/);
  assert.doesNotMatch(html, /Manage routines<\/button>|Edit routine<\/button>|Create routine<\/button>/);
});
