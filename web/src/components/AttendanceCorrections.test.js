import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let server, Attendance, AuthContext;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  ({ default: Attendance } = await server.ssrLoadModule('/src/components/Attendance.jsx'));
});
after(async () => { await server?.close(); });

const person = { id: 'worker', full_name: 'Scoped Worker', employee_code: 'W01', entity_id: 'company', branch_id: 'branch' };
const outsider = { ...person, id: 'outsider', full_name: 'Outside Worker', employee_code: 'X01', branch_id: 'outside' };
const manager = { ...person, id: 'manager', full_name: 'HR reviewer', employee_code: 'HR01' };
const workDate = '2026-07-15';
const row = { id: 'day', employee_id: person.id, work_date: workDate, status: 'Present', day_type: 'working', day_fraction: 1,
  check_in: `${workDate}T09:10:00+05:30`, check_out: `${workDate}T18:00:00+05:30`,
  first_punch_at: `${workDate}T09:30:00+05:30`, last_punch_at: `${workDate}T18:00:00+05:30`,
  punches: [`${workDate}T09:30:00+05:30`, `${workDate}T18:00:00+05:30`], worked_minutes: 530, ot_minutes: 20,
  shift: { code: 'GEN', start_time: '09:00', end_time: '18:00', full_day_minutes: 510, break_minutes: 40 } };
const request = { id: 'request', employee_id: person.id, requested_by: 'another-user', work_date: workDate,
  entity_id: 'company', branch_id: 'branch', reason: 'Missed check in', status: 'Pending', employee: person };

function render({ route = `/attendance/regularizations?employee=worker&date=${workDate}`, self = false,
  locked = false, requests = [], canCreate = true, attendanceError, manage = false, payrollManage = false,
  attendanceRows, payrollAttendance = [] } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, retryOnMount: false, staleTime: Infinity, gcTime: 0 } } });
  const who = self ? person : manager;
  const keys = ['attendance.read', ...(manage ? ['attendance.manage'] : []), ...(payrollManage ? ['payroll.manage'] : []), ...(canCreate ? ['regularization.create'] : []), ...(!self ? ['regularization.approve'] : [])];
  const permissions = keys.map(permission => ({ permission, scope_type: self ? 'self' : 'branch', scope_id: self ? null : 'branch' }));
  const day = { ...row, is_locked: locked };
  const attendanceKey = ['attendance', 'month', person.id, '2026-07-01'];
  for (const [key, data] of [
    [['employees'], [person, outsider, manager]],
    [attendanceKey, [day]],
    [['attendance', 'employee', person.id, '2026-07-01', '2026-07-31'], attendanceRows ?? [day]],
    [['payroll-attendance-summary', person.entity_id, '2026-07'], payrollAttendance],
    [['regularizations', 'Pending', 'everyone'], requests],
    [['regularizations', 'all', person.id], requests],
    [['regularizations', 'mine', who.id], []],
  ]) client.setQueryData(key, data);
  if (attendanceError) client.getQueryCache().find({ queryKey: attendanceKey, exact: true })
    .setState({ status: 'error', fetchStatus: 'idle', error: new Error('Attendance unavailable') });
  const auth = { user: { id: 'current-user' }, employee: who, isSuperAdmin: false, assignments: [], permissions };
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(AuthContext.Provider, { value: auth },
        React.createElement(MemoryRouter, { initialEntries: [route] }, React.createElement(Attendance)))));
  } finally { client.clear(); }
}

const formHtml = html => html.match(/<form\b[\s\S]*?<\/form>/)?.[0] ?? '';
const submitDisabled = html => /<button[^>]*disabled=""[^>]*>Submit for approval<\/button>/.test(formHtml(html));

test('HR deep link selects only a permitted employee and date, with separate device and attendance times', () => {
  const html = render();
  assert.match(formHtml(html), /value="worker" selected=""/);
  assert.match(formHtml(html), /value="2026-07-15"/);
  assert.doesNotMatch(formHtml(html), /Outside Worker/);
  assert.match(formHtml(html), /Recorded punches/);
  assert.match(formHtml(html), /Current attendance/);
  assert.match(formHtml(html), /Another reviewer must approve/);
  assert.equal(submitDisabled(html), false);
});

test('foreign employee links and missing creation permission cannot submit a correction', () => {
  const foreign = render({ route: `/attendance/regularizations?employee=outsider&date=${workDate}` });
  assert.match(foreign, /not available in your correction scope/);
  assert.equal(submitDisabled(foreign), true);
  assert.equal(submitDisabled(render({ self: true, canCreate: false })), true);
});

test('self service ignores a foreign employee parameter and retains its own correction form', () => {
  const html = render({ self: true, route: `/attendance/regularizations?employee=outsider&date=${workDate}` });
  assert.doesNotMatch(formHtml(html), /Correction employee|Outside Worker/);
  assert.match(formHtml(html), /your attendance for that date/);
  assert.match(formHtml(html), /Current attendance/);
  assert.equal(submitDisabled(html), false);
});

test('published days and unavailable attendance reads block correction submission', () => {
  const html = render({ locked: true });
  assert.match(html, /locked by published payroll/);
  assert.equal(submitDisabled(html), true);
  const failed = render({ attendanceError: true });
  assert.match(failed, /Attendance unavailable/);
  assert.equal(submitDisabled(failed), true);
});

test('an HR filer cannot approve their own on-behalf request; independent reviewers can', () => {
  const own = render({ requests: [{ ...request, requested_by: 'current-user' }] });
  assert.match(own, /Another reviewer must decide/);
  assert.doesNotMatch(own, />Approve<\/button>/);
  assert.match(render({ requests: [request] }), />Approve<\/button>/);
});

test('payroll employee-month route opens that month and offers daily corrections only for unlocked days', () => {
  const route = '/attendance/person?employee=worker&period=2026-07';
  const html = render({ route });
  assert.match(html, /2026-07-01 to 2026-07-31/);
  assert.match(html, /attendance\/regularizations\?employee=worker&amp;date=2026-07-15/);
  assert.match(html, /Correct times/);
  const locked = render({ route, locked: true });
  assert.match(locked, /Published · locked/);
  assert.doesNotMatch(locked, /Correct times/);
});

test('person deep links do not disclose an employee outside attendance scope', () => {
  const html = render({ route: '/attendance/person?employee=outsider&period=2026-07' });
  assert.match(html, /not available in your attendance scope/);
  assert.doesNotMatch(html, /Outside Worker|Correct times/);
  const self = render({ self: true, route: '/attendance/person?employee=outsider&period=2026-07' });
  assert.doesNotMatch(self, /Attendance employee|Outside Worker|By person/);
});


test('HR gets direct Edit punches from the employee day and date links open the inline editor', () => {
  const route = '/attendance/person?employee=worker&period=2026-07';
  const html = render({ route, manage: true });
  assert.match(html, /Edit punches/);
  assert.doesNotMatch(html, /Correct times|Request a punch correction/);
  const editing = render({ route: `${route}&correctDate=2026-07-15`, manage: true });
  assert.match(editing, /Punch correction date/);
  assert.match(editing, /Save punch correction/);
  assert.match(editing, /EasyTime Pro and original device punches stay unchanged/);
  const locked = render({ route, manage: true, locked: true });
  assert.match(locked, /Published · locked/);
});

const issueRoute = '/attendance/person?employee=worker&period=2026-07&show=issues&from=payroll&entity=company&payrollPeriod=2026-07';
test('payroll correction opens only issue dates and offers inline editing plus a direct return', () => {
  const html = render({ route: issueRoute, manage: true, payrollManage: true, attendanceRows: [
    { ...row, id: 'missing', work_date: '2026-07-14', is_missing_punch: true },
    { ...row, id: 'break', work_date: '2026-07-13', breaks_incomplete: true },
    { ...row, id: 'late', work_date: '2026-07-12', is_late: true },
    { ...row, id: 'absent', work_date: '2026-07-11', status: 'Absent', day_fraction: 0 },
    { ...row, id: 'invalid', work_date: '2026-07-10', day_fraction: null },
  ] });
  const table = html.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0];
  assert.match(html, /Back to payroll/);
  assert.match(html, /value="Issue dates only"[^>]* selected=""/);
  assert.match(html, /3 dates need review/);
  assert.match(table, /14 Jul|13 Jul|10 Jul/);
  assert.doesNotMatch(table, /12 Jul|11 Jul/);
  assert.match(table, /Missing punch|Incomplete break punches|Invalid attendance credit/);
  assert.match(table, /Edit punches/);
  assert.doesNotMatch(table, /attendance\/regularizations|Correct times/);
  assert.match(html, /value="Every day"/);
});

test('payroll review adds unprocessed dates only inside the server employment interval', () => {
  const html = render({ route: issueRoute, manage: true, payrollManage: true, payrollAttendance: [{ employee_id: 'worker',
    in_payroll_month: true, employment_from: '2026-07-14', employment_to: '2026-07-16' }] });
  const table = html.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0];
  assert.match(html, /2 dates need review/);
  assert.match(table, /14 Jul/);
  assert.match(table, /16 Jul/);
  assert.match(table, /Not processed/);
  assert.doesNotMatch(table, /15 Jul|13 Jul|17 Jul/);
});

test('payroll reviewers without attendance management can review issues without being redirected into requests', () => {
  const html = render({ route: issueRoute, payrollManage: true, attendanceRows: [{ ...row, is_missing_punch: true }] });
  assert.match(html, /attendance management permission is required/);
  assert.match(html, /Back to payroll/);
  assert.doesNotMatch(html, /Correct times|Request a punch correction|Save punch correction/);
});

test('HR viewing their own payroll attendance stays in review and requires another HR manager to correct it', () => {
  const html = render({ route: issueRoute.replace('employee=worker', 'employee=manager'), manage: true, payrollManage: true });
  assert.match(html, /Another HR manager must correct your own attendance/);
  assert.match(html, /Back to payroll/);
  assert.doesNotMatch(html, /Correct times|Request a punch correction|Save punch correction|>Edit punches</);
});
