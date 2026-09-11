import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';
import { accountFixtures } from '../test/scaleFixtures.js';
import { istToday } from '../lib/dates.js';
import { rangeFor } from '../lib/dateRange.js';

let server, AuthContext, Administration, Onboarding, Recruitment, ReportTable, Pagination, Payroll,
  RegularizationsView, ExceptionsView, Team, PeopleOverview, Performance, NewConversation, GroupPanel, ConversationSettings, Thread, ChatMonitor;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  ({ default: Administration } = await server.ssrLoadModule('/src/components/Administration.jsx'));
  ({ default: Onboarding } = await server.ssrLoadModule('/src/components/Onboarding.jsx'));
  ({ default: Recruitment } = await server.ssrLoadModule('/src/components/Recruitment.jsx'));
  ({ ReportTable } = await server.ssrLoadModule('/src/components/ReportsAnalytics.jsx'));
  ({ default: Pagination } = await server.ssrLoadModule('/src/components/ui/Pagination.jsx'));
  ({ default: Payroll } = await server.ssrLoadModule('/src/components/Payroll.jsx'));
  ({ RegularizationsView, ExceptionsView } = await server.ssrLoadModule('/src/components/Attendance.jsx'));
  ({ default: Team } = await server.ssrLoadModule('/src/components/Team.jsx'));
  ({ PeopleOverview } = await server.ssrLoadModule('/src/components/Directory.jsx'));
  ({ default: Performance } = await server.ssrLoadModule('/src/components/Performance.jsx'));
  ({ NewConversation, GroupPanel, ConversationSettings, Thread } = await server.ssrLoadModule('/src/components/Messages.jsx'));
  ({ default: ChatMonitor } = await server.ssrLoadModule('/src/components/ChatMonitor.jsx'));
});
after(async () => { await server?.close(); });

function render(Component, seeds = [], props = {}, path = '/', authOverrides = {}) {
  const fixture = accountFixtures();
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, retryOnMount: false, staleTime: Infinity } } });
  for (const [key, data] of [
    [['managed-users'], fixture.users], [['roles'], fixture.roles], [['employees'], fixture.employees],
    [['org', 'all'], fixture.org], ...seeds,
  ]) {
    if (data instanceof Error) {
      client.getQueryCache().build(client, { queryKey: key }).setState({ status: 'error', fetchStatus: 'idle', error: data });
    } else client.setQueryData(key, data);
  }
  const auth = { user: { id: 'reviewer', email: 'reviewer@example.test' }, employee: null,
    isSuperAdmin: true, assignments: [], permissions: [], rank: 1000, signIn() {}, signOut() {}, reloadAccess() {}, ...authOverrides };
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(AuthContext.Provider, { value: auth },
        React.createElement(MemoryRouter, { initialEntries: [path] }, React.createElement(Component, props)))));
  } finally { client.clear(); }
}

test('Users & Access mounts 25 account controls for 675 users, with all three companies and 27 pages', () => {
  const html = render(Administration);
  assert.equal((html.match(/<details class="users-account"/g) ?? []).length, 25);
  assert.equal((html.match(/Send password reset to /g) ?? []).length, 25);
  for (const label of ['Sample Jewellery', 'Sample Manufacturing', 'Sample Retail', 'Search user accounts',
    'Go to account page', 'Page 1 of 27', 'of 675 accounts', 'Account status']) assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /employee675@example.test/);
});
test('onboarding renders 10 hires with a reachable final page instead of 675 cards', () => {
  const data = Array.from({ length: 675 }, (_, i) => ({ id: `hire-${i}`, name: `Hire ${i}`, tasks: [], progress: 0 }));
  const html = render(Onboarding, [[['onboarding'], data]]);
  assert.equal((html.match(/class="onboarding-hire-card /g) ?? []).length, 10);
  assert.match(html, /Page 1 of 68/);
  assert.doesNotMatch(html, />Hire 674</);
});
test('recruitment bounds each pipeline column independently and pages job openings', () => {
  const candidates = ['Applied', 'Shortlisted', 'Interview', 'Offered'].flatMap((stage) =>
    Array.from({ length: 175 }, (_, i) => ({ id: `${stage}-${i}`, name: `${stage} Candidate ${i}`, stage, job: { title: 'Sample role' } })));
  const jobs = Array.from({ length: 50 }, (_, i) => ({ id: `job-${i}`, title: `Opening ${i}`, status: 'Open', openings: 1 }));
  const html = render(Recruitment, [[['jobs'], jobs], [['candidates'], candidates]]);
  assert.equal((html.match(/class="people-candidate-card"/g) ?? []).length, 32);
  assert.equal((html.match(/class="people-opening-card"/g) ?? []).length, 8);
  assert.equal((html.match(/class="pagination-page-label">Page 1 of 22<\/span>/g) ?? []).length, 4);
});
test('report paging preserves the full-result footer and accepts React cells without serializing them', () => {
  const rows = Array.from({ length: 675 }, (_, i) => [React.createElement('span', { key: i }, `Report person ${i}`), i]);
  const html = render(ReportTable, [], { headers: ['Person', 'Total'], rows, footer: ['All employees', 227475], resetKey: 'month-1' });
  assert.equal((html.match(/Report person /g) ?? []).length, 25);
  assert.match(html, /227475/); assert.match(html, /Totals include all 675 matching rows/);
});
test('small initial page sizes remain available after increasing the size', () => {
  const html = render(Pagination, [], { page: 1, totalPages: 1, pageSize: 50, initialPageSize: 8,
    count: 12, from: 1, to: 12, setPage() {}, setPageSize() {} });
  assert.match(html, /value="8"/); assert.match(html, /Rows per page/);
});

test('monthly payroll renders 25 payslips rather than all 675 employees', () => {
  const now = new Date();
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const slips = accountFixtures().employees.map((employee) => ({ id: `slip-${employee.id}`, employee,
    employee_id: employee.id, period, net: 20000, status: 'Published' }));
  const html = render(Payroll, [[['payslips', 'all', period], slips]], {}, '/payroll/payslips');
  assert.equal((html.match(/Net pay/g) ?? []).length, 25);
  assert.match(html, /of 675 payslips/); assert.match(html, /Payslip month/);
});
test('salary structures page the full current roster and retain the search field', () => {
  const structures = accountFixtures().employees.map((employee) => ({ id: `salary-${employee.id}`,
    employee_id: employee.id, employee, effective_from: '2020-01-01', basic: 10000, gross: 20000 }));
  const html = render(Payroll, [[['salary-structures', 'all'], structures]], {}, '/payroll/salary');
  assert.equal((html.match(/data-label="Employee"/g) ?? []).length, 25);
  assert.match(html, /of 675 salary records/); assert.match(html, /Search current salaries/);
});

test('675 attendance corrections render 25 review rows and page personal history without truncating it', () => {
  const employee = { id: 'self', full_name: 'Reviewer' };
  const queue = Array.from({ length: 675 }, (_, i) => ({ id: `correction-${i}`,
    employee_id: i === 0 ? employee.id : `employee-${i}`, employee: { id: `employee-${i}`, full_name: `Person ${i}` },
    work_date: '2026-09-01', reason: `Missing punch ${i}`, status: 'Pending' }));
  const mine = Array.from({ length: 17 }, (_, i) => ({ id: `mine-${i}`, work_date: '2026-09-01', status: 'Approved' }));
  const html = render(RegularizationsView, [
    [['regularizations', 'Pending', 'everyone'], queue], [['regularizations', 'mine', employee.id], mine],
  ], { employee, canApprove: true }, '/attendance/regularizations', { employee });
  assert.equal((html.match(/data-label="Reason"/g) ?? []).length, 25);
  assert.equal((html.match(/data-label="Decision"/g) ?? []).length, 25);
  assert.match(html, /Another reviewer must decide/);
  assert.match(html, /of 675 pending requests/);
  assert.match(html, /of 17 my requests/);
  assert.match(html, /Page 1 of 3/);
  assert.match(html, /Search attendance corrections/);
  assert.doesNotMatch(html, /Missing punch 674/);
});

test('employee correction details show outcomes and reviewer notes without approval controls', () => {
  const employee = { id: 'self' };
  const requests = [{ id: 'correction-1', employee_id: employee.id, employee, work_date: '2026-09-01',
    reason: 'Missed checkout', status: 'Rejected', decision_note: 'Please provide the actual checkout time.' }];
  const html = render(RegularizationsView, [
    [['regularizations', 'all', employee.id], requests], [['regularizations', 'mine', employee.id], []],
  ], { employee, canApprove: false }, '/attendance/regularizations', { employee, isSuperAdmin: false });
  assert.match(html, /My request details/);
  assert.match(html, /data-label="Status"/);
  assert.match(html, /Rejected/);
  assert.match(html, /Please provide the actual checkout time\./);
  assert.doesNotMatch(html, /data-label="Decision"/);
});

test('attendance and team fetch failures are reported instead of claiming the collections are empty', () => {
  const error = new Error('Connection unavailable');
  const corrections = render(RegularizationsView, [[['regularizations', 'Pending', 'everyone'], error]], { canApprove: true });
  assert.match(corrections, /role="alert"/);
  assert.match(corrections, /Connection unavailable/);
  assert.doesNotMatch(corrections, /Nothing waiting for approval/);
  const team = render(Team, [[['my-departments'], [{ id: 'dept-1', name: 'Sales' }]], [['department-members', 'dept-1'], error]]);
  assert.match(team, /Could not load team members: Connection unavailable/);
  assert.doesNotMatch(team, /Nobody in this department yet/);
});

test('team roster renders 25 out of 675 members with name and code search', () => {
  const html = render(Team, [
    [['my-departments'], [{ id: 'dept-1', name: 'Sales', headcount: 675 }]],
    [['department-members', 'dept-1'], accountFixtures().employees],
  ]);
  assert.equal((html.match(/aria-label="Remove [^"]+ from the team"/g) ?? []).length, 25);
  assert.match(html, /Search team members/);
  assert.match(html, /of 675 people/);
  assert.match(html, /Page 1 of 27/);
});

test('shared pagers offer first and last page controls without submitting an enclosing form', () => {
  const html = render(Pagination, [], { page: 1, totalPages: 27, pageSize: 25, count: 675,
    from: 1, to: 25, setPage() {}, setPageSize() {} });
  assert.match(html, /aria-label="First page"/);
  assert.match(html, /aria-label="Last page"/);
  assert.match(html, /aria-live="polite"/);
  const buttons = html.match(/<button\b[^>]*>/g) ?? [];
  assert.ok(buttons.length > 4);
  assert.ok(buttons.every((button) => button.includes('type="button"')));
});

test('roster quality counts unique incomplete people and MTD excludes future joiners', () => {
  const now = new Date();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const employees = [
    { id: 'incomplete', full_name: 'Incomplete record', join_date: today, status: 'Active' },
    { id: 'future', full_name: 'Future joiner', join_date: '2999-01-01', email: 'future@example.test', branch_id: 'branch-1', status: 'Active' },
  ];
  const html = render(PeopleOverview, [], { employees, filtered: employees, activeFilterCount: 0 });
  assert.match(html, /1 record needs attention/);
  assert.match(html, /<strong>1<\/strong><small>Joined MTD<\/small>/);
});

test('675 team goals stay paged and searchable', () => {
  const goals = accountFixtures().employees.map((employee, i) => ({ id: `goal-${i}`, title: `Goal ${i}`,
    employee, employee_id: employee.id, status: 'Active', progress: 25 }));
  const html = render(Performance, [[['goals'], goals]], {}, '/performance/team');
  assert.equal((html.match(/<article /g) ?? []).length, 25);
  assert.match(html, /of 675 goals/);
  assert.match(html, /Search goals/);
  assert.doesNotMatch(html, />Goal 674</);
});

test('attendance exceptions page all 675 records instead of rendering the whole date range', () => {
  const { from, to } = rangeFor('week', istToday());
  const exceptions = accountFixtures().employees.map((employee, i) => ({ id: `exception-${i}`, employee,
    work_date: to, status: 'Present', is_late: true, late_minutes: 15 }));
  const html = render(ExceptionsView, [[['attendance', 'exceptions', from, to], exceptions]]);
  assert.equal((html.match(/data-label="Issue"/g) ?? []).length, 25);
  assert.match(html, /of 675 attendance exceptions/);
  assert.match(html, /Search attendance exceptions/);
  assert.match(html, /Late 15m/);
});

test('goal management controls follow each row scope even when reading a wider team', () => {
  const goals = ['branch-1', 'branch-2'].map((branch_id, i) => ({ id: `goal-${i}`, title: `Scoped goal ${i}`,
    branch_id, employee_id: `employee-${i}`, status: 'Active', progress: 25 }));
  const html = render(Performance, [[['goals'], goals]], {}, '/performance/team', {
    isSuperAdmin: false, employee: { id: 'manager' },
    permissions: [{ permission: 'performance.manage', scope_type: 'branch', scope_id: 'branch-1' }],
  });
  assert.equal((html.match(/aria-label="Remove goal"/g) ?? []).length, 1);
  assert.equal((html.match(/> Drop<\/button>/g) ?? []).length, 1);
});

test('chat person and group-member pickers keep all 675 people reachable in bounded pages', () => {
  const fixture = accountFixtures();
  const picker = render(NewConversation, [], { me: 'not-in-fixture', onClose() {}, onOpened() {} });
  assert.equal((picker.match(/>Sample Employee \d+</g) ?? []).length, 12);
  assert.match(picker, /of 675 people/);
  assert.match(picker, /role="dialog"/);
  const panel = render(GroupPanel, [], { conversation: { id: 'group-1', kind: 'group', title: 'Everyone',
    members: fixture.employees.map((employee) => ({ employee_id: employee.id, employee })) }, me: 'not-in-fixture', onClose() {} });
  assert.equal((panel.match(/title="Remove"/g) ?? []).length, 12);
  assert.match(panel, /of 675 group members/);
  const monitor = render(ChatMonitor);
  assert.equal((monitor.match(/class="chat-monitor-row"/g) ?? []).length, 25);
  assert.match(monitor, /of 675 people/);
});

test('chat exposes earlier pages and read-only monitoring has no message or membership actions', () => {
  const conversation = { id: 'conversation-1', kind: 'group', title: 'Sample chat', members: [], unread_count: 0 };
  const message = { id: 'message-1', conversation_id: conversation.id, sender_id: 'self', kind: 'text',
    body: 'Latest message', created_at: '2026-09-01T09:00:00Z' };
  const pages = { pages: [{ messages: [message], nextCursor: { id: message.id, created_at: message.created_at } }], pageParams: [null] };
  const html = render(Thread, [[['messages', conversation.id, 'pages'], pages]], { conversation, me: 'self', readOnly: true, onBack() {} });
  assert.match(html, /Latest message/);
  assert.match(html, /Load older messages/);
  assert.doesNotMatch(html, /aria-label="Message options"/);
  assert.doesNotMatch(html, /aria-label="Group settings"/);
  const older = { ...message, id: 'older', body: 'Original message', created_at: '2026-08-01T09:00:00Z' };
  const allPages = { pages: [...pages.pages, { messages: [older], nextCursor: null }], pageParams: [null, pages.pages[0].nextCursor] };
  const history = render(Thread, [[['messages', conversation.id, 'pages'], allPages]], { conversation, me: 'self', readOnly: true, onBack() {} });
  assert.ok(history.indexOf('Original message') < history.indexOf('Latest message'));
  assert.doesNotMatch(history, /Load older messages/);
});


test('chat and group settings share the same Back flow while only group members edit identity', () => {
  const members = [
    { employee_id: 'self', employee: { full_name: 'My Employee', employee_code: 'SELF' } },
    { employee_id: 'other', employee: { full_name: 'Colleague Name', employee_code: 'EMP002' } },
  ];
  for (const kind of ['direct', 'group']) {
    const conversation = { id: `settings-${kind}`, kind, title: 'Our group', members };
    const html = render(ConversationSettings, [], { conversation, me: 'self', onClose() {} });
    assert.match(html, /aria-label="Back to chat"/);
    assert.match(html, /Colleague Name/);
    assert.match(html, /EMP002/);
    if (kind === 'group') {
      assert.match(html, /Group name/);
      assert.match(html, /Change picture/);
      assert.match(html, /Add people/);
      assert.match(html, /Leave group/);
    } else {
      assert.doesNotMatch(html, /<input/);
      assert.doesNotMatch(html, /Change picture|Group name|Add people|Leave group/);
      assert.doesNotMatch(html, /Our group/);
    }
    const monitored = render(ConversationSettings, [], { conversation, me: 'outsider', readOnly: true, onClose() {} });
    assert.doesNotMatch(monitored, /<input|Change picture|Add people|Leave group/);
  }
});
