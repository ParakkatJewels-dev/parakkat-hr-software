import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';
import { accountFixtures } from '../test/scaleFixtures.js';

let server, AuthContext, Administration, Onboarding, Recruitment, ReportTable, Pagination, Payroll;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  ({ default: Administration } = await server.ssrLoadModule('/src/components/Administration.jsx'));
  ({ default: Onboarding } = await server.ssrLoadModule('/src/components/Onboarding.jsx'));
  ({ default: Recruitment } = await server.ssrLoadModule('/src/components/Recruitment.jsx'));
  ({ ReportTable } = await server.ssrLoadModule('/src/components/ReportsAnalytics.jsx'));
  ({ default: Pagination } = await server.ssrLoadModule('/src/components/ui/Pagination.jsx'));
  ({ default: Payroll } = await server.ssrLoadModule('/src/components/Payroll.jsx'));
});
after(async () => { await server?.close(); });

function render(Component, seeds = [], props = {}, path = '/') {
  const fixture = accountFixtures();
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, staleTime: Infinity } } });
  for (const [key, data] of [
    [['managed-users'], fixture.users], [['roles'], fixture.roles], [['employees'], fixture.employees],
    [['org', 'all'], fixture.org], ...seeds,
  ]) client.setQueryData(key, data);
  const auth = { user: { id: 'reviewer', email: 'reviewer@example.test' }, employee: null,
    isSuperAdmin: true, assignments: [], permissions: [], rank: 1000, signIn() {}, signOut() {}, reloadAccess() {} };
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(AuthContext.Provider, { value: auth },
        React.createElement(MemoryRouter, { initialEntries: [path] }, React.createElement(Component, props)))));
  } finally { client.clear(); }
}

test('Users & Access mounts 25 account controls for 675 users, with all three companies and 27 pages', () => {
  const html = render(Administration);
  assert.equal((html.match(/<details /g) ?? []).length, 25);
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
  assert.equal((html.match(/Page 1 of 22/g) ?? []).length, 4);
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
