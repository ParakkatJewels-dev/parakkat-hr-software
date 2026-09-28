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

test('edits allow today and keep one assignee and all jobs, with history guidance', () => {
  const html = render(RoutineForm, { props: { today, initial: { id: 'routine-1', title: 'Opening checks', employee_id: 'employee-1', employee: person(1),
    frequency: 'monthly', month_day: 31, start_date: addDays(today, -10), jobs: [{ title: 'Unlock' }, { title: 'Count stock' }, { title: 'Retired check', is_active: false }] }, onSave() {}, onClose() {} } });
  assert.match(html, /Save routine/);
  assert.match(html, /earlier completion history is preserved/);
  assert.match(html, new RegExp(`min="${today}"`));
  assert.match(html, /value="Count stock"/);
  assert.doesNotMatch(html, /Retired check/);
  assert.match(html, /Shorter months use their last day/);
  assert.match(html, /Other employees keep their existing routines/);
  assert.doesNotMatch(html, /Search employees/);
  assert.doesNotMatch(html, /disabled=""[^>]*>Save routine/);
});

test('adding jobs opens an existing checklist with a new row without creating a separate routine', () => {
  const html = render(RoutineForm, { props: { today, initial: { id: 'routine-1', title: 'Opening checks', employee_id: 'employee-1', employee: person(1),
    addJob: true, frequency: 'once', start_date: today, jobs: [{ id: 'job-1', title: 'Unlock' }] }, onSave() {}, onClose() {} } });
  assert.match(html, /value="Unlock"/);
  assert.match(html, /Job 2 name/);
  assert.match(html, /type="date" min="[^"]+"[^>]*value="[^"]+"/);
  assert.match(html, /Jobs already completed today stay checked/);
  assert.match(html, /type="submit" disabled=""/);
  assert.doesNotMatch(html, /Assign routine to/);
});

test('adding jobs to an interval routine defaults to its next due date without shifting cadence', () => {
  const html = render(RoutineForm, { props: { today, initial: { id: 'routine-1', title: 'Stock review', employee_id: 'employee-1', employee: person(1),
    addJob: true, frequency: 'interval', interval_days: 3, start_date: addDays(today, -2), jobs: [{ id: 'job-1', title: 'Count stock' }] }, onSave() {}, onClose() {} } });
  assert.match(html, new RegExp(`<input[^>]*type="date"[^>]*min="${today}"[^>]*value="${addDays(today, 1)}"`));
  assert.match(html, /suggested date keeps the existing repeat schedule/);
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

test('management allows editing routines due today, hides replaced copies, and respects server authority', () => {
  const routine = { id: 'routine-1', title: 'Current opening', employee_id: 'employee-1', employee: person(1), frequency: 'daily', start_date: today, jobs: [job(0)], can_manage: true };
  const rows = [routine, { ...routine, id: 'closing', title: 'Ending routine', retired_on: today },
    { ...routine, id: 'replaced', title: 'Earlier version', replaced_by: 'routine-1' }, { ...routine, id: 'denied', can_manage: undefined },
    { ...routine, id: 'once', title: 'One-time check', frequency: 'once', end_date: today }];
  const html = render(TaskRoutine, { route: '/tasks/routine?routineView=manage', auth: { isSuperAdmin: true }, seeds: [[['routine-sets', 'all', false], rows]] });
  assert.equal((html.match(/Edit routine<\/button>/g) ?? []).length, 3);
  assert.equal((html.match(/Add jobs<\/button>/g) ?? []).length, 3);
  assert.equal((html.match(/Retire routine<\/button>/g) ?? []).length, 2);
  assert.doesNotMatch(html, />Earlier version<\/h4>/);
  for (const label of ['Ends today', 'All designations', 'All departments', 'All branches']) assert.ok(html.includes(label), label);
});

test('heads can open dashboard daily status for the selected date and invalid dates fall back to today', () => {
  const selected = addDays(today, -1);
  const manager = render(TaskRoutine, { route: `/tasks/routine?routineView=team&routineSection=daily&routineDate=${selected}`,
    auth: { isSuperAdmin: true }, seeds: [[['routine-day', selected, 'all'], [job(0)]]] });
  assert.match(manager, new RegExp(`Team routines for ${selected}`));
  assert.match(manager, /Untick Opening job 0/);
  for (const invalid of ['not-a-date', '2026-02-30']) {
    const html = render(TaskRoutine, { route: `/tasks/routine?routineView=team&routineSection=daily&routineDate=${invalid}`, auth: { isSuperAdmin: true } });
    assert.match(html, new RegExp(`Team routines for ${today}`));
  }
});

test('routine read errors offer a retry and avoid declaring an empty schedule', () => {
  const html = render(TaskRoutine, { seeds: [[['routine-day', today, 'employee-1'], new Error('Routine connection unavailable')]] });
  assert.match(html, /Routine connection unavailable/);
  assert.match(html, /Retry routines/);
  assert.doesNotMatch(html, /No routines are due/);
});

test('only the authorized latest archived routine exposes deleted-job restoration', () => {
  const routine = { id: 'routine-1', title: 'Retired opening', employee_id: 'employee-1', employee: person(1), frequency: 'daily',
    start_date: addDays(today, -10), retired_on: today, can_manage: true,
    jobs: [job(0), { id: 'deleted', title: 'Deleted check', is_active: false, deleted_at: `${today}T00:00:00Z` }] };
  const rows = [routine, { ...routine, id: 'old', replaced_by: routine.id }, { ...routine, id: 'denied', can_manage: false },
    { ...routine, id: 'legacy', jobs: [{ id: 'legacy-job', is_active: false, title: 'Legacy retired job' }] }];
  const html = render(TaskRoutine, { route: '/tasks/routine?routineView=manage', auth: { isSuperAdmin: true }, seeds: [[['routine-sets', 'all', false], rows]] });
  assert.equal((html.match(/Restore deleted jobs<\/button>/g) ?? []).length, 1);
  assert.match(html, /Retired jobs remain in completion history/);
  assert.equal((html.match(/Edit routine<\/button>/g) ?? []).length, 2);
  assert.equal((html.match(/Restore routine<\/button>/g) ?? []).length, 2);
});

test('retired routine recovery is separate from deleted jobs and respects server management permission', () => {
  const routine = { id: 'retired', title: 'Retired opening', employee_id: 'employee-1', employee: person(1),
    frequency: 'daily', start_date: addDays(today, -10), retired_on: today, can_manage: true, jobs: [job(0)] };
  const rows = [routine, { ...routine, id: 'active', retired_on: null },
    { ...routine, id: 'denied', can_manage: false }, { ...routine, id: 'older', replaced_by: routine.id }];
  const html = render(TaskRoutine, { route: '/tasks/routine?routineView=manage', auth: { isSuperAdmin: true },
    seeds: [[['routine-sets', 'all', false], rows]] });
  assert.match(html, /<option value="retired">Retired<\/option>/);
  assert.equal((html.match(/Restore routine<\/button>/g) ?? []).length, 1);
  assert.doesNotMatch(html, /Restore deleted jobs<\/button>/);
});

test('restoring from an archived routine explains that saving resumes its schedule', () => {
  const html = render(RoutineForm, { props: { today, initial: { id: 'routine-1', resume: true, title: 'Opening', employee_id: 'employee-1',
    frequency: 'daily', start_date: addDays(today, -10), retired_on: addDays(today, -2),
    jobs: [job(0), { id: 'deleted', title: 'Deleted check', is_active: false, deleted_at: `${today}T00:00:00Z` }] }, onSave() {}, onClose() {} } });
  assert.match(html, /Saving resumes this routine from that date/);
  assert.match(html, /aria-label="Restore job Deleted check"/);
  assert.match(html, new RegExp(`<input[^>]*type="date"[^>]*min="${today}"[^>]*value="${today}"`));
});
