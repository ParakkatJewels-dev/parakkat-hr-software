import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';
import { PAYROLL_REGISTER_COLUMNS } from '../lib/payrollWorksheet.js';

const entityId = '10000000-0000-0000-0000-000000000001';
const period = '2026-09';
const company = { id: entityId, code: 'TEST', name: 'Test company', is_active: true };
const employee = { id: 'worker', full_name: 'Payroll worker', employee_code: 'EMP001', entity_id: entityId, status: 'Active' };
const policy = { entity_id: entityId, divisor_mode: 'calendar', fixed_days: 30, hours_per_day: 8, ot_multiplier: 2, deduct_late: false };
const run = { id: 'run', entity_id: entityId, period, status: 'Draft', employees: 1, total_gross: 30000, total_net: 29000, entity: company, needs_recalculation: false, source_fingerprint: 'reviewed-source-v1' };
const register = { ...Object.fromEntries(PAYROLL_REGISTER_COLUMNS.map(({ key, type }) => [key, type === 'text' ? 'Test' : 0])),
  employee_name: employee.full_name, salary: 30000, earned_salary: 28000, gross_salary: 30000, net_pay_salary: 29000,
  policy, days_per_month: 30, per_day_working_hour: 8, schema_version: 1 };
let server, Payroll, AuthContext, getSessionEntry;

before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  ({ default: Payroll } = await server.ssrLoadModule('/src/components/Payroll.jsx'));
  ({ getPayrollSessionStateEntry: getSessionEntry } = await server.ssrLoadModule('/src/lib/usePayrollSessionState.js'));
});
after(async () => { await server?.close(); });

function render({ role = 'admin', route = 'worksheet', runData = run, rows = [{ id: 'slip', employee_id: employee.id, payroll_register: register }], policyData = policy, error, unsaved } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, retryOnMount: false, staleTime: Infinity, gcTime: 0 } } });
  const seeds = [
    [['org', 'all'], { entities: [company], zones: [], branches: [], departments: [], designations: [] }],
    [['employees'], [employee]], [['payroll-runs'], [runData]],
    [['payroll-monthly-inputs', entityId, period], []], [['payroll-policy', entityId], policyData], [['payroll-worksheet-run', entityId, period], runData],
    [['payroll-register', run.id], rows],
  ];
  for (const [key, data] of seeds) client.setQueryData(key, data);
  if (error) client.getQueryCache().find({ queryKey: ['payroll-register', run.id], exact: true }).setState({ status: 'error', fetchStatus: 'idle', error });
  if (unsaved) getSessionEntry(client, unsaved.key, unsaved.value);
  const auth = { user: { id: 'user' }, employee, isSuperAdmin: role === 'admin', assignments: [],
    permissions: role === 'admin' ? [] : [{ permission: 'payslip.read', scope_type: 'self', scope_id: null }] };
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(AuthContext.Provider, { value: auth },
        React.createElement(MemoryRouter, { initialEntries: [`/payroll/${route}?entity=${entityId}&period=${period}`] }, React.createElement(Payroll)))));
  } finally { client.clear(); }
}

const buttonDisabled = (html, label) => {
  const button = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(match => match[2].replace(/<[^>]*>/g, '').trim() === label);
  assert.ok(button, `Missing ${label} button`);
  return /\sdisabled(?:=|\s|$)/.test(button[1]);
};

test('worksheet shows the full register and preserves distinct monthly and earned salary', () => {
  const html = render();
  assert.match(html, /Monthly payroll worksheet/);
  assert.match(html, /Salary \(monthly\)/);
  assert.match(html, /Salary \(earned\)/);
  const registerHtml = html.slice(html.indexOf('Payroll register ·'));
  assert.equal((registerHtml.match(/<th\b/g) ?? []).length, 33);
  assert.match(html, /Payroll worker/);
  assert.equal(buttonDisabled(html, 'Export Excel'), false);
});

test('stale, incomplete, truncated and failed register reads cannot produce an export', () => {
  for (const options of [
    { runData: { ...run, needs_recalculation: true } },
    { rows: [{ id: 'legacy', payroll_register: null }] },
    { runData: { ...run, employees: 2 } },
    { error: new Error('Register read failed') },
  ]) assert.equal(buttonDisabled(render(options), 'Export Excel'), true);
  assert.match(render({ error: new Error('Register read failed') }), /Register read failed/);
});

test('published month keeps policy read-only while the saved register remains exportable', () => {
  const html = render({ runData: { ...run, status: 'Published' } });
  assert.equal(buttonDisabled(html, 'Save reviewed policy'), true);
  assert.equal(buttonDisabled(html, 'Export Excel'), false);
  assert.match(html, /read-only/);
});

test('employee deep links cannot render company worksheet controls or salary register', () => {
  const html = render({ role: 'employee' });
  assert.doesNotMatch(html, /Save reviewed policy|Export Excel|Payroll register|Monthly payroll worksheet/);
});

test('run screen links to the selected register and blocks stale or empty publication', () => {
  const html = render({ route: 'run', runData: { ...run, needs_recalculation: true } });
  assert.match(html, /Inputs changed/);
  assert.equal(buttonDisabled(html, 'Publish'), true);
  assert.ok(html.includes(`/payroll/worksheet?entity=${entityId}&amp;period=${period}`));
  assert.equal(buttonDisabled(render({ route: 'run', runData: { ...run, employees: 0 } }), 'Publish'), true);
  assert.equal(buttonDisabled(render({ route: 'run', runData: { ...run, source_fingerprint: null } }), 'Publish'), true);
  assert.equal(buttonDisabled(render({ route: 'run' }), 'Publish'), false);
});

test('retained worksheet inputs, import reviews and policy drafts block calculation and publication', () => {
  for (const unsaved of [
    { key: ['inputs', entityId, period], value: { worker: { draft: { incentive: '100' } } } },
    { key: ['preview', entityId, period], value: { rows: [] } },
    { key: ['policy', entityId], value: { dirty: true } },
  ]) {
    const html = render({ route: 'run', unsaved });
    assert.equal(buttonDisabled(html, 'Run payroll'), true);
    assert.equal(buttonDisabled(html, 'Publish'), true);
    assert.match(html, /Save or discard them in Monthly Worksheet/);
  }
  const unrelated = render({ route: 'run', unsaved: { key: ['inputs', 'another-company', period], value: { worker: {} } } });
  assert.equal(buttonDisabled(unrelated, 'Run payroll'), false);
  assert.equal(buttonDisabled(unrelated, 'Publish'), false);
});
