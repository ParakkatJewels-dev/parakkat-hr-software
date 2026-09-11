import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';
import { istToday } from '../../lib/dates.js';

let server, AuthContext, MyRoutineToday, MyTasks;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  ({ MyRoutineToday, MyTasks } = await server.ssrLoadModule('/src/components/dashboard/selfWidgets.jsx'));
});
after(async () => { await server?.close(); });

const me = { id: 'self', full_name: 'Employee One', entity_id: 'company' };
const items = [
  { id: 'opening', employee_id: 'self', title: 'Opening safety check', is_active: true },
  { id: 'closing', employee_id: 'self', title: 'Daily handover', is_active: true },
  { id: 'retired', employee_id: 'self', title: 'Retired checklist', is_active: false },
  { id: 'other', employee_id: 'other', title: 'Other employee secret', is_active: true },
];
const tick = (id, day) => ({ routine_item_id: id, employee_id: 'self', on_date: day });

function render(Component, seeds, { employee = me, isSuperAdmin = false, permissions } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, retryOnMount: false, staleTime: Infinity } } });
  for (const [queryKey, data] of seeds) {
    if (data instanceof Error) client.getQueryCache().build(client, { queryKey }).setState({ status: 'error', error: data, fetchStatus: 'idle' });
    else client.setQueryData(queryKey, data);
  }
  const auth = { user: { id: 'fixture' }, employee, isSuperAdmin, assignments: [],
    permissions: permissions ?? ['task.read', 'task.update'].map(permission => ({ permission, scope_type: 'self', scope_id: null })) };
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(AuthContext.Provider, { value: auth }, React.createElement(Component))));
  } finally { client.clear(); }
}

const routineSeeds = (ticks) => [[['routine-items', 'self'], items], [['routine-ticks', istToday(), 'self'], ticks]];

test('Home shows only the signed-in employee’s active remaining duties, including on a manager account', () => {
  const html = render(MyRoutineToday, routineSeeds([tick('opening', istToday())]), { isSuperAdmin: true });
  assert.match(html, /My routine today/);
  assert.match(html, /Daily handover/);
  assert.match(html, /1 remaining/);
  assert.doesNotMatch(html, /Opening safety check|Retired checklist|Other employee secret/);
});

test('saved completion hides the Home section for that day and the next IST day restores the routine', (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-11T18:29:59Z') });
  const ticks = [tick('opening', '2026-09-11'), tick('closing', '2026-09-11')];
  assert.equal(render(MyRoutineToday, routineSeeds(ticks)), '');
  context.mock.timers.setTime(Date.parse('2026-09-11T18:30:01Z'));
  const html = render(MyRoutineToday, routineSeeds(ticks));
  assert.match(html, /Opening safety check/);
  assert.match(html, /Daily handover/);
  assert.match(html, /2 remaining/);
});

test('failed tick reads stay visible instead of implying the daily routine is finished', () => {
  const html = render(MyRoutineToday, routineSeeds(new Error('Fixture connection failed')));
  assert.match(html, /role="alert"/);
  assert.match(html, /Fixture connection failed/);
  assert.match(html, /Try again/);
  assert.match(html, /disabled=""/);
});

test('an unlinked account never falls back to displaying the whole team’s routine', () => {
  assert.equal(render(MyRoutineToday, [[['routine-items'], items]], { employee: null, isSuperAdmin: true }), '');
});

test('Home keeps the exact task count while showing five readable rows and protecting incomplete subtasks', () => {
  const tasks = Array.from({ length: 8 }, (_, i) => ({ id: `task-${i}`, employee_id: i === 7 ? 'other' : 'self', title: `My fixture task ${i}`, status: 'To Do', priority: 'Medium', due_date: '2026-09-12',
    checklist: i === 0 ? [{ id: 'step', completed_at: null, completed_by: null }] : [] }));
  const html = render(MyTasks, [[['tasks'], tasks]]);
  assert.equal((html.match(/class="home-work-row"/g) ?? []).length, 5);
  assert.match(html, /View all 7 tasks/);
  assert.match(html, /Open subtasks for My fixture task 0/);
  assert.doesNotMatch(html, /My fixture task 7/);
});
