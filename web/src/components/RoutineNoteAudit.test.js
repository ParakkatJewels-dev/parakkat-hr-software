import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';
import { istToday } from '../lib/dates.js';
import { addDays, startOfMonth } from '../lib/dateRange.js';

let server, AuthContext, RoutineNoteAudit, TaskRoutine;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  ({ default: RoutineNoteAudit } = await server.ssrLoadModule('/src/components/RoutineNoteAudit.jsx'));
  ({ default: TaskRoutine } = await server.ssrLoadModule('/src/components/TaskRoutine.jsx'));
});
after(async () => { await server?.close(); });

const today = istToday();
const from = startOfMonth(today);
const employee = { id: 'employee-1', full_name: 'Employee One', employee_code: 'E001' };
const row = (index, overrides = {}) => ({
  id: `note-${index}`, routine_id: `routine-${index}`, employee_id: employee.id,
  routine_name: `Saved routine ${String(index).padStart(2, '0')}`, author_name: 'Recorded employee name',
  on_date: addDays(today, -1), created_at: `${today}T06:30:00Z`,
  employee: { ...employee, full_name: 'Employee snapshot', employee_code: 'SNAP001' },
  completed_jobs: 1, total_jobs: 3, body: `Explanation ${index}: delivery pending.`, ...overrides,
});
const auditKey = (employeeId = 'all', start = from, end = today) => ['routine-notes', 'audit', start, end, employeeId];

function render(Component, { props = {}, seeds = [], auth = {}, route = '/tasks/routine?routineView=notes' } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: {
    enabled: false, retry: false, retryOnMount: false, staleTime: Infinity,
  } } });
  for (const [queryKey, data, error] of seeds) {
    if (data !== undefined) client.setQueryData(queryKey, data);
    if (error) client.getQueryCache().build(client, { queryKey }).setState({
      status: 'error', fetchStatus: 'idle', error,
    });
  }
  const context = { user: { id: 'user-1' }, employee, assignments: [], isSuperAdmin: false,
    permissions: [{ permission: 'task.read', scope_type: 'self' }], ...auth };
  try {
    const html = renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(AuthContext.Provider, { value: context },
        React.createElement(MemoryRouter, { initialEntries: [route] }, React.createElement(Component, props)))));
    return { html, keys: client.getQueryCache().getAll().map(query => query.queryKey) };
  } finally { client.clear(); }
}
const props = { from, to: today, today, onRangeChange() {}, showEmployee: true };

test('history uses occurrence date range and renders recorded routine, employee and progress snapshots', () => {
  const note = row(1, { routine_name: 'Earlier opening schedule' });
  const { html } = render(RoutineNoteAudit, { props, seeds: [[auditKey(), [note]]] });
  assert.match(html, /Routine dates from/);
  assert.match(html, /Routine dates to/);
  assert.match(html, new RegExp(`value="${from}"`));
  assert.match(html, new RegExp(`value="${today}"`));
  assert.match(html, /Notes are shown by routine date/);
  assert.match(html, /Earlier notes stay available after schedule changes/);
  assert.match(html, /Earlier opening schedule/);
  assert.match(html, /Employee snapshot.*SNAP001/);
  assert.match(html, /Recorded employee name/);
  assert.match(html, new RegExp(`For ${note.on_date}.*1 of 3 jobs complete when noted`));
  assert.match(html, new RegExp(`dateTime="${today}T06:30:00Z"`));
  assert.match(html, /Explanation 1: delivery pending/);
});

test('history pages ten records at a time while reporting the total number of saved notes', () => {
  const { html } = render(RoutineNoteAudit, { props, seeds: [[auditKey(), Array.from({ length: 16 }, (_, index) => row(index))]] });
  assert.equal((html.match(/jobs complete when noted/g) ?? []).length, 10);
  assert.match(html, /16 saved notes/);
  assert.match(html, /of 16 routine notes/);
  assert.match(html, /Page 1 of 2/);
  assert.match(html, /Saved routine 09/);
  assert.doesNotMatch(html, /Saved routine 10|Saved routine 15/);
});

test('own history retains routine and author snapshots without repeating the employee directory label', () => {
  const { html, keys } = render(RoutineNoteAudit, { props: { ...props, employeeId: employee.id, showEmployee: false },
    seeds: [[auditKey(employee.id), [row(1)]]] });
  assert.match(html, /Saved routine 01/);
  assert.match(html, /Recorded employee name/);
  assert.doesNotMatch(html, /Employee snapshot|SNAP001/);
  assert.ok(keys.some(key => JSON.stringify(key) === JSON.stringify(auditKey(employee.id))));
  assert.ok(!keys.some(key => JSON.stringify(key) === JSON.stringify(auditKey())));
});

test('failed refresh retains cached notes with an explicit warning and retry, without an empty-history claim', () => {
  const { html } = render(RoutineNoteAudit, { props, seeds: [[auditKey(), [row(2)], new Error('Failed to fetch')]] });
  assert.match(html, /These notes may be out of date/);
  assert.match(html, /Check your connection and try again/);
  assert.match(html, /Retry notes history/);
  assert.match(html, /Saved routine 02/);
  assert.match(html, /Explanation 2/);
  assert.doesNotMatch(html, /No notes were saved|No notes match/);
});

test('initial read errors and invalid ranges do not appear as a successful empty history', () => {
  const failed = render(RoutineNoteAudit, { props, seeds: [[auditKey(), undefined,
    new Error('Routine notes are not available yet. Ask your administrator to apply the routine notes database update.')]] }).html;
  assert.match(failed, /Could not load notes history/);
  assert.match(failed, /apply the routine notes database update/);
  assert.doesNotMatch(failed, /No notes were saved|No notes match/);
  const invalid = render(RoutineNoteAudit, { props: { ...props, invalidRange: 'The start date must be on or before the end date.' },
    seeds: [[auditKey(), [row(1)]]] }).html;
  assert.match(invalid, /role="alert"/);
  assert.match(invalid, /The start date must be on or before the end date/);
  assert.doesNotMatch(invalid, /No notes were saved|No notes match|Saved routine 01/);
});

test('the notes route selects the employee-only query for self readers and the scoped team query for managers', () => {
  const own = render(TaskRoutine, { seeds: [[auditKey(employee.id), [row(3)]]] });
  assert.match(own.html, /aria-pressed="true">Notes history<\/button>/);
  assert.match(own.html, /Saved routine 03/);
  assert.doesNotMatch(own.html, /Employee snapshot|SNAP001|Routine completion statistics/);
  assert.ok(own.keys.some(key => JSON.stringify(key) === JSON.stringify(auditKey(employee.id))));
  assert.ok(!own.keys.some(key => JSON.stringify(key) === JSON.stringify(auditKey())));
  const manager = render(TaskRoutine, { auth: { isSuperAdmin: true }, seeds: [[auditKey(), [row(4)]]] });
  assert.match(manager.html, /aria-pressed="true">Notes history<\/button>/);
  assert.match(manager.html, /Saved routine 04/);
  assert.match(manager.html, /Employee snapshot.*SNAP001/);
  assert.ok(manager.keys.some(key => JSON.stringify(key) === JSON.stringify(auditKey())));
  assert.ok(!manager.keys.some(key => JSON.stringify(key) === JSON.stringify(auditKey(employee.id))));
});
