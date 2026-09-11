import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Writable } from 'node:stream';
import React from 'react';
import { renderToStaticMarkup, renderToPipeableStream } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';
import { istToday } from '../lib/dates.js';

// Inputs come from a real replay of every production migration, not a mock permission matrix.
// Expected visible behavior below is stated separately from navMap/usePermissions.
const KEYS = ['super_admin', 'entity_admin', 'hr_manager', 'zonal_manager', 'branch_manager', 'dept_head', 'employee'];
const MANAGERS = KEYS.filter((key) => key !== 'employee');
const PAYROLL = ['super_admin', 'entity_admin', 'hr_manager'];
const EXPENSE_APPROVERS = ['super_admin', 'entity_admin', 'hr_manager', 'zonal_manager', 'branch_manager'];
const EXPORTERS = EXPENSE_APPROVERS;
const SCOPE = { super_admin: 'global', entity_admin: 'entity', hr_manager: 'entity', zonal_manager: 'zone', branch_manager: 'branch', dept_head: 'department', employee: 'self' };
const INSIDE = { entity_id: 'entity-a', zone_id: 'zone-a', branch_id: 'branch-a', department_id: 'department-a' };
const OUTSIDE = { entity_id: 'entity-b', zone_id: 'zone-b', branch_id: 'branch-b', department_id: 'department-b' };
const people = [
  { id: 'self', user_id: 'viewer', full_name: 'Self Worker', employee_code: 'SELF', email: 'self@example.test', status: 'Active', ...INSIDE },
  { id: 'inside', user_id: 'inside-user', full_name: 'Inside Worker', employee_code: 'INSIDE', email: 'inside@example.test', status: 'Active', ...INSIDE },
  { id: 'outside', user_id: 'outside-user', full_name: 'Outside Worker', employee_code: 'OUTSIDE', email: 'outside@example.test', status: 'Active', ...OUTSIDE },
];
const org = { entities: ['a', 'b'].map((x) => ({ id: `entity-${x}`, name: `Company ${x}`, code: x.toUpperCase(), is_active: true })),
  zones: ['a', 'b'].map((x) => ({ id: `zone-${x}`, name: `Zone ${x}`, entity_id: `entity-${x}`, is_active: true })),
  branches: ['a', 'b'].map((x) => ({ id: `branch-${x}`, name: `Branch ${x}`, code: x.toUpperCase(), entity_id: `entity-${x}`, zone_id: `zone-${x}`, is_active: true })),
  departments: ['a', 'b'].map((x) => ({ id: `department-${x}`, name: `Department ${x}`, entity_id: `entity-${x}`, branch_id: `branch-${x}`, is_active: true })), designations: [] };
let server, matrix, AuthContext, App, Leave, Expense, Payroll, Performance, TaskManagement, Directory, Administration, RegularizationsView, SyncTab, TeamKpis, ZonalKpis, HrKpis, EntityKpis, TodayPriorities, ApprovalsQueue, originalWindow, originalStorage;

before(async () => {
  matrix = JSON.parse(await readFile(new URL('../test/standardRolePermissions.json', import.meta.url), 'utf8'));
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  ({ default: App } = await server.ssrLoadModule('/src/App.jsx'));
  ({ default: Leave } = await server.ssrLoadModule('/src/components/Leave.jsx'));
  ({ default: Expense } = await server.ssrLoadModule('/src/components/Expense.jsx'));
  ({ default: Payroll } = await server.ssrLoadModule('/src/components/Payroll.jsx'));
  ({ default: Performance } = await server.ssrLoadModule('/src/components/Performance.jsx'));
  ({ default: TaskManagement } = await server.ssrLoadModule('/src/components/TaskManagement.jsx'));
  ({ default: Directory } = await server.ssrLoadModule('/src/components/Directory.jsx'));
  ({ default: Administration } = await server.ssrLoadModule('/src/components/Administration.jsx'));
  ({ RegularizationsView } = await server.ssrLoadModule('/src/components/Attendance.jsx'));
  ({ SyncTab } = await server.ssrLoadModule('/src/components/AttendanceAdmin.jsx'));
  ({ TeamKpis, ZonalKpis, HrKpis, EntityKpis, TodayPriorities } = await server.ssrLoadModule('/src/components/Dashboard.jsx'));
  ({ ApprovalsQueue } = await server.ssrLoadModule('/src/components/dashboard/teamWidgets.jsx'));
  originalWindow = globalThis.window;
  originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.localStorage = storage;
  globalThis.window = { localStorage: storage, navigator: { standalone: false }, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} };
});
after(async () => {
  if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
  if (originalStorage === undefined) delete globalThis.localStorage; else Object.defineProperty(globalThis, 'localStorage', originalStorage);
  await server?.close();
});

function actor(key, changes = {}) {
  const scope = SCOPE[key];
  const scope_id = scope === 'global' || scope === 'self' ? null : INSIDE[`${scope === 'department' ? 'department' : scope}_id`];
  const permissions = matrix[key].permissions.map((permission) => ({ permission, scope_type: scope, scope_id }));
  const assignments = [{ role: key, scope_type: scope, scope_id }];
  if (key !== 'employee') {
    permissions.push(...matrix.employee.permissions.map((permission) => ({ permission, scope_type: 'self', scope_id: null })));
    assignments.push({ role: 'employee', scope_type: 'self', scope_id: null });
  }
  return { user: { id: 'viewer', email: 'self@example.test' }, employee: people[0], isSuperAdmin: key === 'super_admin',
    rank: matrix[key].rank, assignments, permissions, hiddenScreens: [], signIn() {}, signOut() {}, reloadAccess() {}, ...changes };
}
const roleRows = () => KEYS.map((key) => ({ id: `role-${key}`, key, name: key, rank: matrix[key].rank, is_system: true, permissionKeys: matrix[key].permissions }));
function tree(Component, auth, seeds = [], path = '/', props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, retryOnMount: false, staleTime: Infinity, gcTime: 0 } } });
  for (const [key, value] of [[['employees'], people], [['org', 'all'], org], [['roles'], roleRows()], [['managed-users'], []],
    [['leaves'], []], [['expenses'], []], [['goals'], []], [['tasks'], []], [['notifications'], []], [['my-departments'], []],
    [['payroll-runs'], []], [['leave-types'], []], [['assets'], []], ...seeds]) {
    if (value instanceof Error) client.getQueryCache().build(client, { queryKey: key }).setState({ status: 'error', fetchStatus: 'idle', error: value });
    else client.setQueryData(key, value);
  }
  const element = React.createElement(QueryClientProvider, { client }, React.createElement(AuthContext.Provider, { value: auth },
    React.createElement(MemoryRouter, { initialEntries: [path] }, React.createElement(Component, props))));
  return { element, client };
}
function render(Component, auth, seeds = [], path = '/', props = {}) {
  const { element, client } = tree(Component, auth, seeds, path, props);
  try { return renderToStaticMarkup(element); } finally { client.clear(); }
}
async function renderApp(auth, path, seeds = []) {
  const { element, client } = tree(App, auth, seeds, path);
  try {
    return await new Promise((resolve, reject) => {
      let html = '';
      const out = new Writable({ write(chunk, _encoding, next) { html += chunk.toString(); next(); } });
      out.on('finish', () => resolve(html));
      const stream = renderToPipeableStream(element, { onAllReady() { stream.pipe(out); }, onError: reject, onShellError: reject });
    });
  } finally { client.clear(); }
}
function records(kind) {
  return people.map((employee) => ({ id: `${kind}-${employee.id}`, employee_id: employee.id, employee,
    entity_id: employee.entity_id, zone_id: employee.zone_id, branch_id: employee.branch_id, department_id: employee.department_id,
    status: 'Pending', type: 'CL', days: 1, start_date: istToday(), end_date: istToday(), work_date: istToday(),
    category: 'Travel', amount: 100, expense_date: istToday(), reason: `${employee.full_name} request`, created_by: `author-${employee.id}` }));
}
const count = (html, pattern) => (html.match(pattern) ?? []).length;
const ROUTES = [
  ['directory', MANAGERS], ['employee-import', MANAGERS], ['team', MANAGERS], ['attendance-person', MANAGERS],
  ['assets', MANAGERS], ['reports', MANAGERS], ['administration', MANAGERS], ['admin-roles', MANAGERS],
  ['organization', ['super_admin', 'entity_admin']], ['admin-audit', ['super_admin', 'entity_admin']],
  ['attendance-admin', PAYROLL], ['recruitment', PAYROLL], ['onboarding', PAYROLL], ['admin-chats', ['super_admin']],
  ['leave', KEYS], ['payroll', KEYS], ['messages', KEYS], ['tasks', KEYS], ['performance', KEYS],
];

test('role fixture covers every real standard role and preserves distinct authority levels', () => {
  assert.deepEqual(Object.keys(matrix).sort(), [...KEYS].sort());
  assert.ok(!matrix.employee.permissions.includes('leave.approve'));
  assert.ok(!matrix.dept_head.permissions.includes('expense.approve'));
  assert.ok(!matrix.hr_manager.permissions.includes('org.manage'));
});

for (const key of KEYS) {
  test(`${key}: real App renders or blocks 19 routes with the final standard grants`, async () => {
    for (const [route, allowed] of ROUTES) {
      const html = await renderApp(actor(key), `/${route}`);
      assert.equal(html.includes('Access restricted'), !allowed.includes(key), `${key} /${route}`);
      assert.match(html, /id="main-content"/);
      assert.doesNotMatch(html, /Switched to client rendering because the server rendering errored/);
    }
  });
  test(`${key}: leave, expense and correction decisions exclude self and outside scope`, () => {
    const auth = actor(key);
    const expectedLeave = key === 'super_admin' ? 2 : key === 'employee' ? 0 : 1;
    const expectedExpense = key === 'super_admin' ? 2 : EXPENSE_APPROVERS.includes(key) ? 1 : 0;
    const leave = render(Leave, auth, [[['leaves'], records('leave')]], '/leave');
    assert.equal(count(leave, /aria-label="Change status for /g), expectedLeave);
    assert.doesNotMatch(leave, /aria-label="Change status for Self Worker"/);
    const expenses = render(Expense, auth, [[['expenses'], records('expense')]], '/expense');
    assert.equal(count(expenses, /aria-label="Approve"/g), expectedExpense);
    const corrections = render(RegularizationsView, auth, [
      [['regularizations', key === 'employee' ? 'all' : 'Pending', key === 'employee' ? 'self' : 'everyone'], records('correction')],
      [['regularizations', 'mine', 'self'], []],
    ], '/attendance/regularizations', { employee: auth.employee, canApprove: key !== 'employee' });
    assert.equal(count(corrections, />Approve<\/button>/g), expectedLeave);
    if (key === 'employee') {
      assert.doesNotMatch(leave, /Inside Worker|Outside Worker/);
      assert.doesNotMatch(expenses, /Inside Worker|Outside Worker/);
    }
  });
  test(`${key}: payroll deep links offer management only to payroll roles`, () => {
    const html = render(Payroll, actor(key), [], '/payroll/run');
    assert.equal(html.includes('Salary Structures'), PAYROLL.includes(key));
    assert.equal(html.includes('Deductions &amp; Allowances'), PAYROLL.includes(key));
    if (!PAYROLL.includes(key)) assert.match(html, /Payslip month/);
  });
  test(`${key}: dashboard approval KPIs, priorities and inline inbox agree on actionable rows`, () => {
    const auth = actor(key);
    const seeds = [
      [['leaves'], records('leave')],
      [['expenses'], [...records('expense'), { ...records('expense')[1], id: 'filed-by-viewer', created_by: 'viewer' }]],
      [['regularizations', 'Pending', 'everyone'], records('correction')],
    ];
    const leaves = key === 'super_admin' ? 2 : key === 'employee' ? 0 : 1;
    const expenses = key === 'super_admin' ? 2 : EXPENSE_APPROVERS.includes(key) ? 1 : 0;
    const total = leaves * 2 + expenses;
    for (const Kpis of [TeamKpis, ZonalKpis]) {
      const html = render(Kpis, auth, seeds);
      assert.match(html, new RegExp(`Pending Approvals<\\/span><\\/div><div class="dashboard-kpi-body"><p>${total}<\\/p>`));
    }
    for (const Kpis of [HrKpis, EntityKpis]) {
      assert.match(render(Kpis, auth, seeds), new RegExp(`Pending Leaves<\\/span><\\/div><div class="dashboard-kpi-body"><p>${leaves}<\\/p>`));
    }
    const inbox = render(ApprovalsQueue, auth, seeds);
    if (key === 'employee') assert.equal(inbox, '');
    else {
      assert.match(inbox, new RegExp(`dashboard-badge">${total}<`));
      assert.match(inbox, new RegExp(`Leaves · ${leaves}<`));
      assert.match(inbox, new RegExp(`Punches · ${leaves}<`));
      if (EXPENSE_APPROVERS.includes(key)) assert.match(inbox, new RegExp(`Expenses · ${expenses}<`));
      else assert.doesNotMatch(inbox, /Expenses ·/);
      assert.equal(count(inbox, /> Approve<\/button>/g), leaves);
      assert.doesNotMatch(inbox, /Self Worker/);
      if (key !== 'super_admin') assert.doesNotMatch(inbox, /Outside Worker/);
    }
    const priorities = render(TodayPriorities, auth, seeds, '/', { role: key });
    if (leaves) {
      assert.match(priorities, new RegExp(`${leaves} punch correction${leaves > 1 ? 's' : ''} waiting`));
      assert.match(priorities, new RegExp(`${leaves} leave request${leaves > 1 ? 's' : ''} need decision`));
    }
    if (expenses) assert.match(priorities, new RegExp(`${expenses} expense claim${expenses > 1 ? 's' : ''} pending`));
    else assert.doesNotMatch(priorities, /expense claims? pending/);
  });
  test(`${key}: goals use per-row authority and personal tasks remain usable`, () => {
    const goals = records('goal').map((row) => ({ ...row, title: `${row.employee.full_name} goal`, status: 'Active', progress: 25 }));
    const html = render(Performance, actor(key), [[['goals'], goals]], '/performance/team');
    assert.equal(count(html, /aria-label="Remove goal"/g), key === 'super_admin' ? 2 : key === 'employee' ? 0 : 1);
    if (key === 'employee') { assert.match(html, /Self Worker goal/); assert.doesNotMatch(html, /Inside Worker goal|Outside Worker goal/); assert.match(html, /> Done<\/button>/); }
    const ownTasks = render(TaskManagement, actor(key), [], '/tasks/todo');
    assert.match(ownTasks, /Add a task for yourself/);
  });
  test(`${key}: directory create and export actions match company versus department authority`, () => {
    const html = render(Directory, actor(key));
    assert.equal(html.includes('>Add person<'), key !== 'employee');
    assert.equal(html.includes('aria-label="Export csv"'), EXPORTERS.includes(key));
  });
  test(`${key}: account reset controls respect seniority and employee scope`, () => {
    const targetPeople = KEYS.map((target) => ({ ...people[1], id: `target-${target}`, user_id: `user-${target}`, full_name: `Target ${target}` }));
    targetPeople.push({ ...people[2], id: 'remote', user_id: 'remote-user', full_name: 'Remote employee' });
    const users = targetPeople.map((employee, i) => ({ user_id: employee.user_id, email: `${i}@example.test`, employee_id: employee.id,
      employee_name: employee.full_name, is_super_admin: i === 0,
      roles: [{ assignment_id: `assignment-${i}`, role_key: KEYS[i] ?? 'employee', scope_type: 'self' }] }));
    const html = render(Administration, actor(key), [[['employees'], [...people, ...targetPeople]], [['managed-users'], users]]);
    const expected = key === 'super_admin' ? users.length : key === 'employee' ? 0 : KEYS.filter((target) => matrix[target].rank < matrix[key].rank).length;
    assert.equal(count(html, /Send password reset to /g), expected);
    if (key !== 'super_admin') assert.doesNotMatch(html, /Send password reset to 7@example.test/);
  });
}

test('unlinked system login cannot open messaging or file personal leave/expenses/tasks', async () => {
  const auth = actor('super_admin', { employee: null });
  assert.match(await renderApp(auth, '/messages'), /Access restricted/);
  assert.doesNotMatch(render(Leave, auth), />Apply for Leave<|>Apply Leave</);
  assert.doesNotMatch(render(Expense, auth), />New Claim</);
  const todo = render(TaskManagement, auth, [], '/tasks/todo');
  assert.match(todo, /Your login is not linked to an employee record/);
  assert.doesNotMatch(todo, /Add a task for yourself/);
});

test('unassigned account cannot gain protected screens from a typed route', async () => {
  const auth = actor('employee', { employee: null, permissions: [], assignments: [] });
  for (const route of ['directory', 'payroll', 'administration', 'reports', 'admin-chats', 'messages', 'tasks']) {
    assert.match(await renderApp(auth, `/${route}`), /Access restricted/, route);
  }
});

test('combined HR and department roles retain both scopes without acquiring company administration', async () => {
  const hr = actor('hr_manager');
  const combined = { ...hr, assignments: [...hr.assignments, { role: 'dept_head', scope_type: 'department', scope_id: 'department-b' }],
    permissions: [...hr.permissions, ...matrix.dept_head.permissions.map((permission) => ({ permission, scope_type: 'department', scope_id: 'department-b' }))] };
  assert.match(await renderApp(combined, '/organization'), /Access restricted/);
  assert.doesNotMatch(await renderApp(combined, '/payroll/run'), /Access restricted/);
  const leave = render(Leave, combined, [[['leaves'], records('leave')]], '/leave');
  assert.equal(count(leave, /aria-label="Change status for /g), 2);
  const expense = render(Expense, combined, [[['expenses'], records('expense')]], '/expense');
  assert.equal(count(expense, /aria-label="Approve"/g), 1);
  const inbox = render(ApprovalsQueue, combined, [[['leaves'], records('leave')], [['expenses'], records('expense')],
    [['regularizations', 'Pending', 'everyone'], records('correction')]]);
  assert.match(inbox, /Leaves · 2</);
  assert.match(inbox, /Punches · 2</);
  assert.match(inbox, /Expenses · 1</);
  assert.match(inbox, /dashboard-badge">5</);
});

test('a per-user hidden screen is blocked even when its role grant remains', async () => {
  assert.match(await renderApp(actor('hr_manager', { hiddenScreens: ['directory'] }), '/directory'), /Access restricted/);
  assert.doesNotMatch(await renderApp(actor('super_admin', { hiddenScreens: ['directory'] }), '/directory'), /Access restricted/);
});

test('scoped service diagnostics denial is not described as a disconnected attendance service', () => {
  const denied = Object.assign(new Error('Global scope required'), { status: 403 });
  const html = render(SyncTab, actor('hr_manager'), [[['service-status'], denied],
    [['sync-health'], { level: 'ok', punchesToday: 123, lastSuccess: new Date().toISOString(), newestRunAt: new Date().toISOString() }]]);
  assert.match(html, /Detailed service diagnostics require global attendance administration access/);
  assert.match(html, /123/);
  assert.doesNotMatch(html, /cannot reach it|need a browser on the office network/);
});

test('approval inbox fetch errors remain visible without claiming the queue is clear', () => {
  const html = render(ApprovalsQueue, actor('branch_manager'), [[['leaves'], new Error('Cannot load approval requests')]]);
  assert.match(html, /role="alert"[^>]*>Cannot load approval requests/);
  assert.doesNotMatch(html, /Queue is clear/);
});

test('HR dashboard month-to-date joiners exclude hires after today', () => {
  const html = render(HrKpis, actor('hr_manager'), [[['employees'], [
    { ...people[0], join_date: istToday() }, { ...people[1], join_date: '2099-12-31' },
  ]]]);
  assert.match(html, /Joiners \(MTD\)<\/span><\/div><div class="dashboard-kpi-body"><p>1<\/p>/);
});
