import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';
import { currentSalaryMap, filterSalaryEmployees, salarySetupDraft, salarySetupPayload } from '../lib/payrollSalarySetup.js';

const people = Array.from({ length: 67 }, (_, index) => ({ id: `worker-${index}`, full_name: `Salary person ${index}`,
  employee_code: `EMP${index}`, entity_id: 'company-a', branch_id: index % 2 ? 'branch-b' : 'branch-a', status: 'Active' }));
const salary = { id: 'salary-current', employee_id: people[0].id, effective_from: '2020-01-01', basic: 10000, gross: 15000,
  notes: JSON.stringify({ note: 'Approved salary', retained_flag: true, gross_components: [{ name: 'HRA', amount: 5000 }] }) };
const future = { ...salary, id: 'salary-future', effective_from: '2099-01-01', basic: 12000, gross: 17000 };
const org = { entities: [{ id: 'company-a', name: 'Company A' }], zones: [], departments: [], designations: [],
  branches: [{ id: 'branch-a', entity_id: 'company-a', name: 'Branch A' }, { id: 'branch-b', entity_id: 'company-a', name: 'Branch B' }] };
let server, PayrollSalarySetup, AuthContext, getEntry;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ default: PayrollSalarySetup } = await server.ssrLoadModule('/src/components/PayrollSalarySetup.jsx'));
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  ({ getPayrollSessionStateEntry: getEntry } = await server.ssrLoadModule('/src/lib/usePayrollSessionState.js'));
});
after(async () => { await server?.close(); });

function render({ permission = 'admin', rows = [salary, future], error, draft, path = '/payroll/salary' } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, retryOnMount: false, staleTime: Infinity, gcTime: 0 } } });
  client.setQueryData(['employees'], people);
  client.setQueryData(['salary-structures', 'all'], rows);
  client.setQueryData(['org', 'all'], org);
  if (error) client.getQueryCache().find({ queryKey: ['salary-structures', 'all'], exact: true }).setState({ status: 'error', fetchStatus: 'idle', error });
  if (draft) getEntry(client, ['salary-setup'], draft);
  const auth = { user: { id: 'reviewer' }, employee: people[0], isSuperAdmin: permission === 'admin', assignments: [],
    permissions: permission === 'branch' ? [{ permission: 'payroll.manage', scope_type: 'branch', scope_id: 'branch-a' }]
      : permission === 'self' ? [{ permission: 'payroll.manage', scope_type: 'self', scope_id: null }] : [] };
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(AuthContext.Provider, { value: auth },
        React.createElement(MemoryRouter, { initialEntries: [path] }, React.createElement(PayrollSalarySetup)))));
  } finally { client.clear(); }
}

test('salary directory pages all employees including missing salaries without a large employee dropdown', () => {
  const html = render();
  assert.equal((html.match(/data-label="Employee"/g) || []).length, 25);
  assert.match(html, /of 67 employees/);
  assert.match(html, /Search salary employees/);
  assert.match(html, /66 missing salary/);
  assert.match(html, /Salary status/);
  assert.doesNotMatch(html, /<option[^>]*>Salary person/);
  assert.doesNotMatch(html, /Set salary for Salary person 66/);
});

test('salary setup limits the roster to writable payroll scope and refuses employee/self scope', () => {
  const html = render({ permission: 'branch' });
  assert.match(html, /of 34 employees/);
  assert.match(html, /Set salary for Salary person 0 \(EMP0\)/);
  assert.doesNotMatch(html, /Set salary for Salary person 1 \(EMP1\)/);
  assert.doesNotMatch(html, /<option value="branch-b"/);
  assert.match(render({ permission: 'self' }), /No employees are available in your payroll scope/);
  assert.equal(render({ permission: 'employee' }), '');
});

test('failed salary reads do not mislabel employees as missing salary or offer editing', () => {
  const html = render({ error: new Error('Salary read failed') });
  assert.match(html, /Salary read failed/);
  assert.doesNotMatch(html, /67 missing salary|Set salary for|data-label="Salary status"/);
});

test('retained editor keeps labels, current and scheduled history, named components, and saved-date warning', () => {
  const html = render({ draft: salarySetupDraft(people[0], salary, '2026-09-01') });
  for (const text of ['Salary · Salary person 0', 'Monthly basic (₹)', 'Monthly gross (₹)', 'Effective from',
    'Salary history (2)', 'Scheduled', 'Current', 'value="HRA"', 'Saving updates the salary for this date.']) assert.ok(html.includes(text), text);
});

test('a retained draft for an unavailable employee can be discarded so payroll is not stranded', () => {
  const draft = salarySetupDraft({ id: 'departed', entity_id: 'company-a' }, null, '2026-10-01');
  draft.form = { ...draft.form, basic: '10000' };
  const html = render({ draft });
  assert.match(html, /no longer available in this payroll scope/);
  assert.match(html, /Discard salary draft/);
});

test('current salary ignores scheduled raises and does not depend on input sorting', () => {
  const old = { ...salary, id: 'older', effective_from: '2019-01-01', basic: 9000 };
  const result = currentSalaryMap([old, future, salary], '2026-10-07');
  assert.equal(result.get(people[0].id).id, salary.id);
  assert.equal(currentSalaryMap([future], '2026-10-07').size, 0);
});

test('employee search combines name/code, company, branch and missing salary filters', () => {
  const current = currentSalaryMap([salary], '2026-10-07');
  assert.deepEqual(filterSalaryEmployees(people, current, { search: ' emp0 ' }).map(person => person.id), [people[0].id]);
  assert.equal(filterSalaryEmployees(people, current, { status: 'missing' }).length, 66);
  assert.equal(filterSalaryEmployees(people, current, { branch: 'branch-a', status: 'missing' }).length, 33);
  assert.equal(filterSalaryEmployees(people, current, { company: 'company-b' }).length, 0);
});

test('new salary draft honors the supplied payroll effective date while existing history keeps its date', () => {
  assert.equal(salarySetupDraft(people[1], null, '2026-09-01').form.effective_from, '2026-09-01');
  assert.equal(salarySetupDraft(people[0], salary, '2026-09-01').form.effective_from, '2020-01-01');
});

test('salary save preserves exact-date row identity and unrelated notes with validated money', () => {
  const form = salarySetupDraft(people[0], salary).form;
  const payload = salarySetupPayload({ ...form, basic: '11000', gross_components: [{ name: 'HRA', amount: '5500.50' }] }, [salary, future]);
  assert.equal(payload.id, salary.id);
  assert.equal(payload.basic, 11000);
  assert.equal(payload.gross, 16500.5);
  assert.deepEqual(JSON.parse(payload.notes), { note: 'Approved salary', retained_flag: true, gross_components: [{ name: 'HRA', amount: 5500.5 }] });
  assert.equal(salarySetupPayload({ ...form, effective_from: '2026-11-01' }, [salary]).id, undefined);
  assert.throws(() => salarySetupPayload({ ...form, basic: '-1' }, []), /cannot be negative/);
  assert.throws(() => salarySetupPayload({ ...form, basic: 'invalid' }, []), /valid amounts/);
  assert.throws(() => salarySetupPayload({ ...form, gross_components: [{ name: '', amount: '10' }] }, []), /gross name/);
  assert.throws(() => salarySetupPayload({ ...form, effective_from: '' }, []), /effective-from date/);
});
