import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';
import { istToday } from '../lib/dates.js';
import { addDays, startOfMonth } from '../lib/dateRange.js';

let server, AuthContext, TaskRoutine, RoutineDayList, RoutinePeoplePicker, RoutineForm, RoutineStatistics;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  ({ default: TaskRoutine, RoutineDayList } = await server.ssrLoadModule('/src/components/TaskRoutine.jsx'));
  ({ default: RoutinePeoplePicker } = await server.ssrLoadModule('/src/components/RoutinePeoplePicker.jsx'));
  ({ default: RoutineForm } = await server.ssrLoadModule('/src/components/RoutineForm.jsx'));
  ({ default: RoutineStatistics } = await server.ssrLoadModule('/src/components/RoutineStatistics.jsx'));
});
after(async () => { await server?.close(); });

const today = istToday();
const person = (index) => ({ id: `employee-${index}`, full_name: `Person ${index}`, employee_code: `P${index}`,
  designation_id: index % 2 ? 'cashier' : 'sales', designation: { title: index % 2 ? 'Cashier' : 'Sales associate' },
  department_id: 'retail', department: { name: 'Retail' }, branch_id: 'branch-1', branch: { code: 'MAIN' } });
const job = (index, changes = {}) => ({ id: `job-${index}`, title: `Opening job ${index}`, routine_id: 'routine-1',
  routine_name: 'Opening checks', employee_id: 'employee-1', employee: person(1), frequency: 'daily',
  sort_order: index, done: index < 15, can_tick: true, ...changes });
const stats = Array.from({ length: 65 }, (_, index) => ({ id: `stats-${index}`, routine_id: `routine-${index}`,
  routine_name: `Routine ${index}`, employee_id: `employee-${index}`, employee: person(index), frequency: 'daily',
  scheduled: 3, completed: 1, missed: 1, pending: 1, total_jobs: 3, done_jobs: 1 }));

function render(Component, { seeds = [], props = {}, auth = {}, route = '/tasks/routine' } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, retryOnMount: false, staleTime: Infinity } } });
  for (const [key, data] of seeds) {
    if (data instanceof Error) client.getQueryCache().build(client, { queryKey: key }).setState({ status: 'error', fetchStatus: 'idle', error: data });
    else client.setQueryData(key, data);
  }
  const context = { user: { id: 'user-1' }, employee: person(1), isSuperAdmin: false, assignments: [],
    permissions: [{ permission: 'task.read', scope_type: 'self' }], ...auth };
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(AuthContext.Provider, { value: context }, React.createElement(MemoryRouter, { initialEntries: [route] }, React.createElement(Component, props)))));
  } finally { client.clear(); }
}

test('routine employee lookup loading and failures keep entered jobs and block assignment without an empty roster claim', () => {
  const props = { today, employees: [person(1)], initial: { employee_id: 'employee-1', title: 'Opening checks',
    jobs: [{ title: 'Count stock' }] }, onSave() {}, onClose() {} };
  const loading = render(RoutineForm, { props: { ...props, employeesLoading: true } });
  assert.match(loading, /Loading employees for routine assignment/);
  assert.match(loading, /value="Opening checks"/); assert.match(loading, /value="Count stock"/);
  assert.match(loading, /type="submit" disabled=""/);
  assert.doesNotMatch(loading, /No employees|0 matching employees/);
  const failed = render(RoutineForm, { props: { ...props, employeesError: new Error('Failed to fetch'), onRetryEmployees() {} } });
  assert.match(failed, /Employees could not be loaded/); assert.match(failed, /Try again/);
  assert.match(failed, /type="submit" disabled=""/); assert.doesNotMatch(failed, /No employees|0 matching employees/);
});

test('bulk employee selection pages a large pool while retaining selections beyond the page and exact designation choices', () => {
  const html = render(RoutinePeoplePicker, { props: { employees: Array.from({ length: 675 }, (_, index) => person(index)),
    selectedIds: ['employee-674', 'employee-1'], onChange() {} } });
  assert.equal((html.match(/aria-label="Assign Person /g) ?? []).length, 25);
  for (const label of ['2 selected · 675 matching employees', 'Select all 675 matching employees', 'Cashier', 'Sales associate', 'All departments', 'All branches', 'of 675 employees', 'Page 1 of 27']) assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /aria-label="Assign Person 674 /);
});

test('bulk assignment keeps the 1000-person limit visible and never offers an oversized select-all', () => {
  const html = render(RoutinePeoplePicker, { props: { employees: Array.from({ length: 1001 }, (_, index) => person(index)), selectedIds: [], onChange() {} } });
  assert.match(html, /<button[^>]*disabled=""[^>]*>Select all 1001 matching employees<\/button>/);
  assert.match(html, /Assign up to 1,000 employees at a time/);
});

test('future edits keep one assignee and all jobs, with schedule validation aligned to the server', () => {
  const html = render(RoutineForm, { props: { today, initial: { id: 'routine-1', title: 'Opening checks', employee_id: 'employee-1', employee: person(1),
    frequency: 'monthly', month_day: 31, start_date: addDays(today, -10), jobs: [{ title: 'Unlock' }, { title: 'Count stock' }, { title: 'Retired check', is_active: false }] }, onSave() {}, onClose() {} } });
  assert.match(html, /Save future changes/);
  assert.match(html, /Completed work and earlier schedules stay in history/);
  assert.match(html, new RegExp(`min="${addDays(today, 1)}"`));
  assert.match(html, /value="Count stock"/);
  assert.doesNotMatch(html, /Retired check/);
  assert.match(html, /Shorter months use their last day/);
  assert.match(html, /Other employees keep their existing routines/);
  assert.doesNotMatch(html, /Search employees/);
  assert.doesNotMatch(html, /disabled=""[^>]*>Save future changes/);
});

test('daily checklists page whole routines and their jobs without hiding full progress', () => {
  const rows = Array.from({ length: 13 }, (_, routine) => Array.from({ length: 35 }, (_, index) => job(index, {
    id: `${routine}-${index}`, routine_id: `routine-${routine}`, routine_name: `Opening ${String(routine).padStart(2, '0')}`,
  }))).flat();
  const html = render(RoutineDayList, { props: { title: 'Team routines', rows, today, day: today, query: {}, onTick: {}, showEmployee: true } });
  assert.equal((html.match(/aria-label="15 of 35 jobs completed"/g) ?? []).length, 10);
  assert.equal((html.match(/aria-label="Untick Opening job /g) ?? []).length, 100);
  for (const label of ['13 routines due', 'of 13 team routines', 'of 35 jobs', 'All designations', 'All departments', 'All branches']) assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, />Opening 12</);
});

test('completion controls fail closed and the Employee view cannot correct a past due date', () => {
  const props = { title: 'My routines', rows: [job(0, { title: 'Missing grant', can_tick: undefined }), job(1, { title: 'Granted job' })], today, day: today, query: {}, onTick: {} };
  const html = render(RoutineDayList, { props });
  const tags = html.match(/<button\b[^>]*>/g) ?? [];
  assert.match(tags.find((tag) => tag.includes('Untick Missing grant')), /disabled=""/);
  assert.doesNotMatch(tags.find((tag) => tag.includes('Untick Granted job')), /disabled=""/);
  const past = render(RoutineDayList, { props: { ...props, day: addDays(today, -1), viewingAsEmployee: true } });
  assert.match((past.match(/<button\b[^>]*>/g) ?? []).find((tag) => tag.includes('Untick Granted job')), /disabled=""/);
});

test('statistics count all due jobs before pagination and keep unknown legacy schedules outside rates', () => {
  const rows = stats.map((row, index) => ({ ...row, history_start_date: index === 0 ? today : null, unscored_done_jobs: index === 0 ? 8 : 0 }));
  const html = render(RoutineStatistics, { props: { rows, from: addDays(today, -6), to: today, today, onRangeChange() {} } });
  assert.equal((html.match(/<td data-label="Employee">/g) ?? []).length, 25);
  assert.match(html, /Due jobs<\/p><p[^>]*>195<\/p>/);
  assert.match(html, /Completed jobs<\/p><p[^>]*>65<\/p>/);
  assert.match(html, /Completion rate<\/p><p[^>]*>33%<\/p>/);
  assert.match(html, /of 65 routine summaries/);
  assert.match(html, /Earlier saved job completions: 8/);
  assert.match(html, new RegExp(`Schedule tracked from ${today}`));
  assert.doesNotMatch(html, />Jobs done</);
  assert.doesNotMatch(html, /Compare completed routines/);
});

test('the Home team link opens statistics first and self-only readers cannot activate the team view', () => {
  const seeds = [[['routine-stats', startOfMonth(today), today, null], stats], [['routine-day', today, 'employee-1'], [job(0)]]];
  const manager = render(TaskRoutine, { seeds, route: '/tasks/routine?routineView=team', auth: { isSuperAdmin: true } });
  assert.match(manager, /Routine completion statistics/);
  assert.match(manager, /aria-pressed="true">Statistics<\/button>/);
  assert.match(manager, /Daily checklists/);
  assert.doesNotMatch(manager, /Tick Opening job/);
  assert.doesNotMatch(manager, /<span>Routine date<\/span>/);
  const own = render(TaskRoutine, { seeds, route: '/tasks/routine?routineView=team' });
  assert.match(own, /My routines for/);
  assert.doesNotMatch(own, /Routine completion statistics/);
  assert.doesNotMatch(own, /Team overview/);
});

test('management offers future changes only for live server-authorized assignments and exposes organization filters', () => {
  const routine = { id: 'routine-1', title: 'Current opening', employee_id: 'employee-1', employee: person(1), frequency: 'daily', start_date: today, jobs: [job(0)], can_manage: true };
  const rows = [routine, { ...routine, id: 'closing', title: 'Ending routine', retired_on: today },
    { ...routine, id: 'replaced', title: 'Earlier version', replaced_by: 'routine-1' }, { ...routine, id: 'denied', can_manage: undefined }];
  const html = render(TaskRoutine, { route: '/tasks/routine?routineView=manage', auth: { isSuperAdmin: true }, seeds: [[['routine-sets', 'all', false], rows]] });
  assert.equal((html.match(/Edit routine<\/button>/g) ?? []).length, 1);
  assert.equal((html.match(/Retire routine<\/button>/g) ?? []).length, 1);
  for (const label of ['Ends today', 'All designations', 'All departments', 'All branches']) assert.ok(html.includes(label), label);
});

test('routine read errors offer a retry and avoid declaring an empty schedule', () => {
  const html = render(TaskRoutine, { seeds: [[['routine-day', today, 'employee-1'], new Error('Routine connection unavailable')]] });
  assert.match(html, /Routine connection unavailable/);
  assert.match(html, /Retry routines/);
  assert.doesNotMatch(html, /No routines are due/);
});
