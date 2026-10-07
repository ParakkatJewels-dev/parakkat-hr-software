import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer, transformWithOxc } from 'vite';
import { PAYROLL_REGISTER_COLUMNS } from '../lib/payrollWorksheet.js';

const entityId = '10000000-0000-0000-0000-000000000001';
const period = '2026-09';
const company = { id: entityId, code: 'TEST', name: 'Test company', is_active: true };
const employee = { id: 'worker', full_name: 'Payroll worker', employee_code: 'EMP001', entity_id: entityId, status: 'Active' };
const policy = { entity_id: entityId, divisor_mode: 'calendar', fixed_days: 30, hours_per_day: 8, ot_multiplier: 2, deduct_late: false };
const run = { id: 'run', entity_id: entityId, period, status: 'Draft', employees: 1, total_gross: 30000, total_net: 29000, entity: company, needs_recalculation: false, source_fingerprint: 'reviewed-source-v1' };
const register = { ...Object.fromEntries(PAYROLL_REGISTER_COLUMNS.map(({ key, type }) => [key, type === 'text' ? 'Test' : 0])),
  employee_name: employee.full_name, salary: 30000, earned_salary: 28000, gross_salary: 30000, net_pay_salary: 29000,
  policy, days_per_month: 30, per_day_working_hour: 8, total_working_hours: 208.5, ot_hours: 4.5, late_hours: 0.75, schema_version: 1 };
let server, Payroll, AuthContext, getSessionEntry, handlerLoader, TestRegister, TestCompanyWorksheet;

before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  ({ default: Payroll } = await server.ssrLoadModule('/src/components/Payroll.jsx'));
  ({ getPayrollSessionStateEntry: getSessionEntry } = await server.ssrLoadModule('/src/lib/usePayrollSessionState.js'));
  // Exercise real event handlers without database writes. Only scheduling, data hooks and
  // child components are isolated; the source still supplies navigation and publication logic.
  const sourceUrl = new URL('./PayrollWorksheet.jsx', import.meta.url);
  const virtualUrl = `${sourceUrl.href}?workflow-handler-tests`;
  const source = `${await readFile(sourceUrl, 'utf8')}\nexport { Register as TestRegister, CompanyWorksheet as TestCompanyWorksheet };`;
  const { code } = await transformWithOxc(source, sourceUrl.pathname, { jsx: { runtime: 'automatic' } });
  const stubs = {
    react: `export { default } from ${JSON.stringify(import.meta.resolve('react'))}; export const useState = initial => globalThis.payrollFlow.state(initial); export const useEffect = () => {}; export const useMemo = compute => compute();`,
    '@tanstack/react-query': 'export const useQueryClient = () => globalThis.payrollFlow.client; export const useIsMutating = () => globalThis.payrollFlow.activeSaves;',
    'react-router-dom': 'export const Link = "a"; export const useSearchParams = () => [globalThis.payrollFlow.params, next => { globalThis.payrollFlow.params = next; }];',
    'lucide-react': 'export const AlertTriangle="icon", ArrowLeft="icon", ArrowRight="icon", Check="icon", Download="icon", Loader2="icon", LockKeyhole="icon", Play="icon";',
    '../auth/usePermissions': 'export const usePermissions = () => ({ can: () => true, canAny: () => true });',
    '../data/employees': 'export const useEmployees = () => ({ data: [] });',
    '../data/org': 'export const useVisibleOrg = () => ({ data: { entities: [] } });',
    '../data/attendance': 'export const todayIso = () => "2026-10-07";',
    '../data/payrollWorksheet': `export const usePayrollPolicy = () => globalThis.payrollFlow.policy;
      export const usePayrollWorksheetRun = () => globalThis.payrollFlow.run;
      export const usePayrollRegister = () => globalThis.payrollFlow.register;
      export const useSavePayrollPolicy = () => globalThis.payrollFlow.save;
      export const usePayrollMonthlyInputs = () => globalThis.payrollFlow.inputs;
      export const usePayrollAttendanceSummary = () => globalThis.payrollFlow.attendance;`,
    '../lib/payrollWorksheet': `export { payrollRegisterColumns, payrollPolicyDraft, formatPayrollDayHours, isCompletePayrollRegister } from ${JSON.stringify(new URL('../lib/payrollWorksheet.js', import.meta.url).href)}; export const exportPayrollRegister = (...args) => { globalThis.payrollFlow.exports.push(args); };`,
    '../lib/usePayrollSessionState': 'export const hasPayrollSessionChanges = () => globalThis.payrollFlow.pending; export const usePayrollSessionState = (key, initial) => globalThis.payrollFlow.sessionState(key, initial);',
    '../data/payroll': 'export const useRunPayroll = () => globalThis.payrollFlow.calculate; export const usePublishPayroll = () => globalThis.payrollFlow.publish;',
    './ui/Btn': 'export const btnClass = () => "button";',
    './ui/Pagination': 'export default "pagination"; export const usePagination = rows => ({ slice: rows, count: rows.length });',
    './ui/ListSearch': 'export default "list-search";',
    './ui/ConfirmDialog': 'export default "confirm-dialog";',
    '../data/payrollTransactions': 'export const usePayrollAdjustments = () => globalThis.payrollFlow.adjustments; export const usePayrollAdvanceRecoveries = () => globalThis.payrollFlow.recoveries;',
    './PayrollTransactions': 'export default "transactions"; export const PayrollPayments = "payments";',
    './PayrollSheetFrame': 'export default "sheet-frame";',
    './PayrollInputGrid': 'export default "input-grid";',
    './payrollWorkflow.css': 'export default {};',
  };
  handlerLoader = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === virtualUrl && stubs[specifier]) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
      return next(specifier, context);
    },
    load(url, context, next) { return url === virtualUrl ? { format: 'module', source: code, shortCircuit: true } : next(url, context); },
  });
  ({ TestRegister, TestCompanyWorksheet } = await import(virtualUrl));
});
after(async () => { handlerLoader?.deregister(); delete globalThis.payrollFlow; await server?.close(); });

function render({ role = 'admin', route = 'run', step, runData = run, rows = [{ id: 'slip', employee_id: employee.id, payroll_register: register }], payslipRows = [], policyData = policy, error, unsaved, queryStates = [] } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, retryOnMount: false, staleTime: Infinity, gcTime: 0 } } });
  const seeds = [
    [['org', 'all'], { entities: [company], zones: [], branches: [], departments: [], designations: [] }],
    [['employees'], [employee]], [['payroll-runs'], runData ? [runData] : []],
    [['payroll-monthly-inputs', entityId, period], []], [['payroll-policy', entityId], policyData], [['payroll-worksheet-run', entityId, period], runData],
    [['payroll-attendance-summary', entityId, period], [{ employee_id: employee.id, recorded_worked_hours: 208, recorded_ot_hours: 4, recorded_late_hours: 1, deductible_late_hours: 0.5, policy_deduct_late: false, attendance_days: 30, expected_days: 30, missing_days: 0, unresolved_days: 0, invalid_days: 0, pending_recompute_days: 0 }]],
    [['payroll-register', run.id], rows],
    [['payroll-adjustments', entityId, period], []], [['payroll-advances', entityId], []], [['payroll-advance-recoveries', entityId], []], [['payroll-payments', run.id], []],
    [['payslips', 'all', period], payslipRows],
  ];
  for (const [key, data] of seeds) client.setQueryData(key, data);
  if (error) client.getQueryCache().find({ queryKey: ['payroll-register', run.id], exact: true }).setState({ status: 'error', fetchStatus: 'idle', error });
  for (const [queryKey, state] of queryStates) client.getQueryCache().find({ queryKey, exact: true }).setState(state);
  if (unsaved) getSessionEntry(client, unsaved.key, unsaved.value);
  const auth = { user: { id: 'user' }, employee, isSuperAdmin: role === 'admin', assignments: [],
    permissions: role === 'admin' ? [] : [{ permission: 'payslip.read', scope_type: 'self', scope_id: null }] };
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(AuthContext.Provider, { value: auth },
        React.createElement(MemoryRouter, { initialEntries: [`/payroll${route ? `/${route}` : ''}?entity=${entityId}&period=${period}${step ? `&step=${step}` : ''}`] }, React.createElement(Payroll)))));
  } finally { client.clear(); }
}

const buttonDisabled = (html, label) => {
  const button = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(match => match[2].replace(/<[^>]*>/g, '').trim() === label);
  assert.ok(button, `Missing ${label} button`);
  return /\sdisabled(?:=|\s|$)/.test(button[1]);
};

test('monthly input salary follows the selected payroll calculation and its read/recalculation state', () => {
  const rows = [{ id: 'slip', employee_id: employee.id, net: '29000', payroll_register: register }];
  const salaryCell = options => render({ rows, ...options }).match(/<td[^>]*aria-label="Payroll worker · Total salary ·[^"]*"[^>]*>([\s\S]*?)<\/td>/)?.[1];
  assert.match(salaryCell({}), /₹29,000\.00[\s\S]*Calculated net pay/);
  assert.match(salaryCell({ runData: { ...run, needs_recalculation: true } }), /Last calculation · recalculate/);
  assert.match(salaryCell({ runData: null }), /Calculate payroll/);
  const loading = salaryCell({ queryStates: [[['payroll-register', run.id], { fetchStatus: 'fetching' }]] });
  assert.match(loading, /Loading salary/); assert.doesNotMatch(loading, /₹/);
  const failed = salaryCell({ error: new Error('Register unavailable') });
  assert.match(failed, /Salary unavailable/); assert.doesNotMatch(failed, /₹/);
  assert.match(salaryCell({ runData: { ...run, status: 'Published' } }), /₹29,000\.00[\s\S]*Published net pay/);
});

test('managers start in the three-step monthly workflow with one company and month context', () => {
  const html = render({ route: '' });
  assert.match(html, /Monthly payroll steps/);
  assert.match(html, /1\. Prepare monthly data/);
  assert.equal((html.match(/type="month"/g) ?? []).length, 1);
  const steps = html.match(/<nav[^>]*aria-label="Monthly payroll steps"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
  assert.ok(steps);
  assert.equal((steps.match(/<button\b/g) ?? []).length, 3);
  assert.match(steps, /Prepare data/);
  assert.match(steps, /Review payroll/);
  assert.match(steps, /Publish/);
  assert.doesNotMatch(html, /Search payslips|Monthly Worksheet/);
  assert.equal(buttonDisabled(html, 'Continue to review'), false);
});

test('legacy worksheet bookmarks open the same selected month and workflow step', () => {
  for (const route of ['run', 'worksheet']) {
    const html = render({ route, step: 'review' });
    assert.match(html, /2\. Calculate and review payroll/);
    assert.match(html, /value="2026-09"/);
    assert.match(html, /Payroll register/);
    assert.doesNotMatch(html, /Employee monthly inputs|3\. Publish reviewed payroll/);
  }
});

test('prepare, review and publish each show one clear stage of the monthly workflow', () => {
  const prepare = render({ step: 'prepare' });
  assert.match(prepare, /Employee monthly inputs/);
  assert.doesNotMatch(prepare, /Search payroll register|3\. Publish reviewed payroll/);
  const review = render({ step: 'review' });
  assert.match(review, /Search payroll register/);
  assert.doesNotMatch(review, /Employee monthly inputs|Save reviewed policy|3\. Publish reviewed payroll/);
  const publish = render({ step: 'publish' });
  assert.match(publish, /3\. Publish reviewed payroll/);
  assert.doesNotMatch(publish, /Employee monthly inputs|Search payroll register|Recalculate payroll/);
});

test('hourly setup uses assigned shifts while legacy daily hours retain their saved policy', () => {
  const setup = render({ policyData: null, runData: null });
  assert.match(setup, /Each date uses its assigned shift/);
  assert.doesNotMatch(setup, /Daily working hours \(decimal\)/);
  const saved = render({ policyData: { ...policy, hours_per_day: 8.3 } });
  assert.match(saved, /Saved · calendar days · 8h 18m \/ day/);
  assert.match(saved, /aria-describedby="payroll-daily-hours-help"[^>]*value="8\.3"/);
  const reviewed = render({ step: 'review', policyData: { ...policy, hours_per_day: 8.5 },
    rows: [{ id: 'slip', employee_id: employee.id, payroll_register: {
      ...register, policy: { ...policy, hours_per_day: 8.3 },
    } }] });
  assert.match(reviewed, /Saved calculation basis: calendar days, 8h 18m per day/);
});

test('register shows saved worked, OT and late hours beside salary without expanding columns', () => {
  const html = render({ step: 'review' });
  assert.match(html, /Salary \(monthly\)/);
  assert.match(html, /Salary \(earned\)/);
  const registerHtml = html.slice(html.indexOf('Payroll register ·'));
  assert.equal((registerHtml.match(/<th\b/g) ?? []).length, 9);
  assert.match(registerHtml, /Total Working Hours/);
  assert.match(registerHtml, /Ot Hours/);
  assert.match(registerHtml, /late hours/);
  assert.match(registerHtml, />208\.5</);
  assert.match(registerHtml, />4\.5</);
  assert.match(registerHtml, />0\.75</);
  assert.match(registerHtml, /30,000\.00/);
  assert.match(registerHtml, /28,000\.00/);
  assert.match(html, /Payroll worker/);
  assert.equal(buttonDisabled(html, 'Show all 33 columns'), false);
  assert.equal(buttonDisabled(html, 'Export Excel'), false);
  assert.equal(buttonDisabled(html, 'Continue to publish'), false);
});

test('stale, incomplete, truncated and failed register reads cannot produce an export', () => {
  for (const options of [
    { runData: { ...run, needs_recalculation: true } },
    { rows: [{ id: 'legacy', payroll_register: null }] },
    { runData: { ...run, employees: 2 } },
    { error: new Error('Register read failed') },
    { rows: [] },
    { runData: null },
    { queryStates: [[['payroll-register', run.id], { fetchStatus: 'fetching' }]] },
  ]) assert.equal(buttonDisabled(render({ step: 'review', ...options }), 'Export Excel'), true);
  assert.match(render({ step: 'review', error: new Error('Register read failed') }), /Register read failed/);
});

test('published month keeps policy read-only while the saved register remains exportable', () => {
  for (const status of ['Published', 'Paid']) {
    const options = { runData: { ...run, status } };
    assert.equal(buttonDisabled(render(options), 'Save reviewed policy'), true);
    const review = render({ step: 'review', ...options });
    assert.equal(buttonDisabled(review, 'Export Excel'), false);
    assert.doesNotMatch(review, /Recalculate payroll|Continue to publish/);
    assert.match(review, /read-only/);
    const publish = render({ step: 'publish', ...options });
    assert.match(publish, /Salary payments/);
    assert.doesNotMatch(publish, />Publish payroll<|3\. Publish reviewed payroll/);
  }
});

test('employee deep links cannot render company worksheet controls or salary register', () => {
  for (const route of ['', 'run', 'worksheet', 'history', 'salary', 'components']) {
    const html = render({ role: 'employee', route, step: 'publish' });
    assert.doesNotMatch(html, /Save reviewed policy|Export Excel|Payroll register|Monthly payroll steps|Salary setup|Pay components/);
    assert.match(html, /Search payslips/);
  }
});

test('payslips retain the selected payroll month and stored company after an employee transfers', () => {
  const otherCompany = '20000000-0000-0000-0000-000000000002';
  const html = render({ route: 'payslips', payslipRows: [
    { id: 'original-company-slip', entity_id: entityId, employee_id: 'transferred', period, status: 'Published', net: 29000,
      employee: { id: 'transferred', full_name: 'Transferred employee', employee_code: 'TRANSFER', entity_id: otherCompany } },
    { id: 'other-company-slip', entity_id: otherCompany, employee_id: 'other-worker', period, status: 'Published', net: 17000,
      employee: { id: 'other-worker', full_name: 'Other payroll company employee', employee_code: 'OTHER', entity_id: entityId } },
  ] });
  assert.match(html, /aria-label="Payslip month"[^>]*value="2026-09"/);
  assert.ok(html.includes(`value="${entityId}" selected=""`));
  assert.match(html, /Transferred employee/);
  assert.match(html, /29,000\.00/);
  assert.doesNotMatch(html, /Other payroll company employee|17,000\.00/);
});

test('publication requires a complete current register, matching headcount and source fingerprint', () => {
  for (const options of [
    { runData: { ...run, needs_recalculation: true } },
    { runData: { ...run, employees: 0 } },
    { runData: { ...run, employees: 2 } },
    { runData: { ...run, source_fingerprint: null } },
    { runData: null },
    { rows: [] },
    { rows: [{ id: 'legacy', employee_id: employee.id, payroll_register: null }] },
    { error: new Error('Register read failed') },
    { queryStates: [[['payroll-register', run.id], { fetchStatus: 'fetching' }]] },
    { queryStates: [[['payroll-worksheet-run', entityId, period], { status: 'error', error: new Error('Run read failed') }]] },
  ]) {
    assert.equal(buttonDisabled(render({ step: 'review', ...options }), 'Continue to publish'), true);
    assert.equal(buttonDisabled(render({ step: 'publish', ...options }), 'Publish payroll'), true);
  }
  assert.equal(buttonDisabled(render({ step: 'publish' }), 'Publish payroll'), false);
});

test('calculation waits for a saved company policy and successful current source reads', () => {
  assert.equal(buttonDisabled(render({ step: 'review' }), 'Recalculate payroll'), false);
  assert.equal(buttonDisabled(render({ step: 'review', runData: null }), 'Calculate payroll'), false);
  assert.equal(buttonDisabled(render({ step: 'review', policyData: null }), 'Recalculate payroll'), true);
  for (const queryKey of [
    ['payroll-policy', entityId], ['payroll-monthly-inputs', entityId, period],
    ['payroll-attendance-summary', entityId, period], ['payroll-worksheet-run', entityId, period],
    ['payroll-adjustments', entityId, period], ['payroll-advance-recoveries', entityId],
    ['org', 'all'], ['employees'],
  ]) for (const state of [{ fetchStatus: 'fetching' }, { status: 'error', error: new Error('Source read failed') }]) {
    assert.equal(buttonDisabled(render({ step: 'review', queryStates: [[queryKey, state]] }), 'Recalculate payroll'), true);
  }
});

test('historical published payslips can track payment without worksheet snapshots while incomplete reads fail closed', () => {
  const legacyRun = { ...run, status: 'Published', source_fingerprint: null };
  const slip = { id: 'legacy', employee_id: employee.id, status: 'Published', net: '29000.00', payroll_register: null,
    employee: { full_name: employee.full_name, employee_code: employee.employee_code } };
  assert.equal(buttonDisabled(render({ step: 'publish', runData: legacyRun, rows: [slip] }), 'Record paid'), false);
  for (const net of [undefined, null, '', -1, 'NaN', false]) {
    const html = render({ step: 'publish', runData: legacyRun, rows: [{ ...slip, net }] });
    assert.equal(buttonDisabled(html, 'Record paid'), true);
  }
  const html = render({ step: 'publish', runData: { ...legacyRun, employees: 2 }, rows: [slip] });
  assert.equal(buttonDisabled(html, 'Record paid'), true);
});

test('retained monthly inputs, import reviews, policy and salary edits block calculation and publication', () => {
  for (const unsaved of [
    { key: ['inputs', entityId, period], value: { worker: { draft: { incentive: '100' } } } },
    { key: ['preview', entityId, period], value: { rows: [] } },
    { key: ['transactions', entityId, period], value: { dirty: true } },
    { key: ['policy', entityId], value: { dirty: true } },
    { key: ['salary-setup'], value: { employeeId: employee.id, entityId, form: { basic: '32000' }, initialForm: { basic: '30000' } } },
  ]) {
    const review = render({ step: 'review', unsaved });
    assert.equal(buttonDisabled(review, 'Recalculate payroll'), true);
    assert.equal(buttonDisabled(review, 'Export Excel'), true);
    assert.equal(buttonDisabled(review, 'Continue to publish'), true);
    const publish = render({ step: 'publish', unsaved });
    assert.equal(buttonDisabled(publish, 'Publish payroll'), true);
    assert.match(publish, /Save or discard them in Prepare data/);
  }
  for (const key of [['inputs', 'another-company', period], ['inputs', entityId, '2026-08'], ['policy', 'another-company']]) {
    const unsaved = { key, value: { dirty: true, worker: {} } };
    assert.equal(buttonDisabled(render({ step: 'review', unsaved }), 'Recalculate payroll'), false);
    assert.equal(buttonDisabled(render({ step: 'publish', unsaved }), 'Publish payroll'), false);
  }
  for (const value of [
    { employeeId: employee.id, entityId, form: { basic: '30000' }, initialForm: { basic: '30000' } },
    { employeeId: 'another-worker', entityId: 'another-company', form: { basic: '32000' }, initialForm: { basic: '30000' } },
  ]) {
    const unsaved = { key: ['salary-setup'], value };
    assert.equal(buttonDisabled(render({ step: 'review', unsaved }), 'Recalculate payroll'), false);
    assert.equal(buttonDisabled(render({ step: 'publish', unsaved }), 'Publish payroll'), false);
  }
});

const nodeText = node => ['string', 'number'].includes(typeof node) ? String(node)
  : React.isValidElement(node) ? React.Children.toArray(node.props.children).map(nodeText).join('') : '';
function findNodes(node, predicate) {
  if (!React.isValidElement(node)) return [];
  return [...(predicate(node) ? [node] : []), ...React.Children.toArray(node.props.children).flatMap(child => findNodes(child, predicate))];
}

function mountFlow({ component = 'workflow', step = 'prepare', canManageCompany = true } = {}) {
  const slots = [], sessions = new Map(); let cursor = 0;
  const query = data => ({ data, isSuccess: true, isLoading: false, isFetching: false, error: null });
  const mutation = () => ({ isPending: false, error: null, calls: [], reset() { this.error = null; }, async mutateAsync(payload) { this.calls.push(payload); } });
  const harness = {
    pending: false, activeSaves: 0, exports: [], params: new URLSearchParams({ entity: entityId, period, step }),
    policy: query(policy), run: query(run), register: query([{ id: 'slip', employee_id: employee.id, payroll_register: register }]),
    inputs: query([]), attendance: query([]), adjustments: query([]), recoveries: query([]), calculate: mutation(), publish: mutation(), save: mutation(),
    props: { entity: company, period, employees: [employee], canManageCompany, inputsDirty: false, inputBusy: false, scopeReadBlocked: false },
    client: { isMutating: ({ predicate }) => { harness.liveMutationPredicate = predicate; return harness.activeSaves; }, getQueryData: key => key[0] === 'payroll-worksheet-run' ? harness.run.data : harness.register.data },
    state(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    sessionState(key, initial) {
      const serialized = JSON.stringify(key);
      if (!sessions.has(serialized)) sessions.set(serialized, typeof initial === 'function' ? initial() : initial);
      return [sessions.get(serialized), next => { sessions.set(serialized, typeof next === 'function' ? next(sessions.get(serialized)) : next); }];
    },
    render() {
      cursor = 0; globalThis.payrollFlow = this;
      return component === 'register' ? TestRegister({ ...this.props, runQuery: this.run, registerQuery: this.register }).props.children({ control: null, expanded: false }) : TestCompanyWorksheet(this.props);
    },
    button(label) {
      return findNodes(this.render(), node => node.type === 'button' && (label instanceof RegExp ? label.test(nodeText(node)) : nodeText(node).trim() === label))[0];
    },
    click(label) {
      const button = this.button(label); assert.ok(button, `Missing ${label}`); assert.ok(!button.props.disabled, `${label} is enabled`);
      return button.props.onClick();
    },
    dialog() { return findNodes(this.render(), node => node.type === 'confirm-dialog')[0]; },
  };
  return harness;
}

test('register column toggle expands all 33 columns while exports retain every employee after filtering', async () => {
  const flow = mountFlow({ component: 'register' });
  const columns = () => findNodes(flow.render(), node => node.type === 'th').map(nodeText);
  assert.equal(columns().length, 9);
  flow.click('Show all 33 columns');
  assert.equal(columns().length, 33);
  assert.ok(columns().includes('Salary (monthly)'));
  assert.ok(columns().includes('Salary (earned)'));
  flow.click('Show salary summary');
  assert.equal(columns().length, 9);
  assert.ok(columns().includes('Total Working Hours'));
  assert.ok(columns().includes('Ot Hours'));
  assert.ok(columns().includes('late hours'));
  findNodes(flow.render(), node => node.type === 'list-search')[0].props.onChange('no matching employee');
  assert.match(nodeText(flow.render()), /No employees match this search/);
  await flow.click('Export Excel');
  assert.deepEqual(flow.exports, [[flow.register.data, company.code, period]]);
});

test('register export waits for calculation completion and rejects stale handlers during live payroll writes', async () => {
  const workflow = mountFlow({ step: 'review' });
  workflow.calculate.isPending = true;
  const registerNode = findNodes(workflow.render(), node => node.type === TestRegister)[0];
  assert.equal(registerNode.props.processing, true, 'calculation blocks the displayed register before queries invalidate');

  const flow = mountFlow({ component: 'register' });
  flow.props.processing = true;
  const blockedExport = flow.button('Export Excel');
  assert.equal(blockedExport.props.disabled, true);
  await blockedExport.props.onClick();
  assert.equal(flow.exports.length, 0);

  flow.props.processing = false;
  const exportWhenReady = flow.button('Export Excel').props.onClick;
  flow.activeSaves = 1; // A payroll write starts after this enabled button was rendered.
  await exportWhenReady();
  assert.equal(flow.exports.length, 0);
  assert.equal(flow.liveMutationPredicate({ options: { mutationKey: ['run-payroll'] } }), true);
  flow.activeSaves = 0;
  await exportWhenReady();
  assert.deepEqual(flow.exports, [[flow.register.data, company.code, period]]);
});

test('step changes preserve company/month and calculation and publication each require their own action', async () => {
  const flow = mountFlow();
  const sheet = findNodes(flow.render(), node => node.type === 'input-grid')[0];
  assert.equal(sheet.props.continueDisabled, false);
  flow.pending = true;
  sheet.props.onContinue();
  assert.equal(flow.params.get('step'), 'prepare', 'a retained draft blocks even an earlier sheet callback');
  flow.pending = false; flow.activeSaves = 1;
  sheet.props.onContinue();
  assert.equal(flow.params.get('step'), 'prepare', 'an in-flight write blocks the sheet callback');
  flow.activeSaves = 0;
  sheet.props.onContinue();
  assert.equal(flow.params.get('step'), 'review');
  assert.equal(flow.params.get('entity'), entityId);
  assert.equal(flow.params.get('period'), period);
  assert.equal(flow.calculate.calls.length, 0);
  await flow.click('Recalculate payroll');
  assert.deepEqual(flow.calculate.calls, [{ entity_id: entityId, period }]);
  flow.click('Continue to publish');
  assert.equal(flow.params.get('step'), 'publish');
  assert.equal(flow.publish.calls.length, 0);
  flow.click('Publish payroll');
  assert.ok(flow.dialog());
  assert.equal(flow.publish.calls.length, 0);
  await flow.dialog().props.onConfirm();
  assert.deepEqual(flow.publish.calls, [{ runId: run.id, expectedFingerprint: run.source_fingerprint }]);
  assert.equal(flow.dialog(), undefined);
});

test('publication confirmation rechecks retained changes added after opening the dialog', async () => {
  const flow = mountFlow({ step: 'publish' });
  flow.click('Publish payroll');
  const confirm = flow.dialog().props.onConfirm;
  flow.pending = true;
  await confirm();
  assert.equal(flow.publish.calls.length, 0);
  assert.ok(flow.dialog());
});

test('stale calculate and publish handlers recheck live payroll writes before submitting', async () => {
  const flow = mountFlow({ step: 'review' });
  const calculate = flow.button('Recalculate payroll').props.onClick;
  flow.activeSaves = 1; // A different write starts after this handler was rendered.
  await calculate();
  assert.equal(flow.calculate.calls.length, 0);
  for (const key of ['save-payroll-monthly-inputs', 'save-payroll-policy', 'save-salary-structure', 'run-payroll', 'publish-payroll']) {
    assert.equal(flow.liveMutationPredicate({ options: { mutationKey: [key] } }), true);
  }
  assert.equal(flow.liveMutationPredicate({ options: { mutationKey: ['save-unrelated-record'] } }), false);
  flow.activeSaves = 0;
  await calculate();
  assert.equal(flow.calculate.calls.length, 1);

  flow.params.set('step', 'publish');
  flow.click('Publish payroll');
  const confirm = flow.dialog().props.onConfirm;
  flow.activeSaves = 1;
  await confirm();
  assert.equal(flow.publish.calls.length, 0);
  assert.ok(flow.dialog());
  flow.activeSaves = 0;
  await flow.dialog().props.onConfirm();
  assert.deepEqual(flow.publish.calls, [{ runId: run.id, expectedFingerprint: run.source_fingerprint }]);
});

test('active input work and limited company permission block workflow mutation handlers', async () => {
  for (const configure of [
    flow => { flow.props.inputBusy = true; },
    flow => { flow.activeSaves = 1; },
    flow => { flow.pending = true; },
    flow => { flow.props.canManageCompany = false; },
  ]) {
    const flow = mountFlow({ step: 'review' }); configure(flow);
    const calculate = flow.button('Recalculate payroll');
    assert.equal(calculate.props.disabled, true);
    await calculate.props.onClick();
    assert.equal(flow.calculate.calls.length, 0);
    assert.equal(flow.button('Continue to publish').props.disabled, true);
  }
  const busy = mountFlow({ step: 'review' });
  busy.props.inputBusy = true;
  const steps = findNodes(busy.render(), node => node.type === 'nav' && node.props['aria-label'] === 'Monthly payroll steps')[0];
  for (const button of findNodes(steps, node => node.type === 'button')) {
    assert.equal(button.props.disabled, true);
    button.props.onClick();
  }
  assert.equal(busy.params.get('step'), 'review');
});

test('hourly policy setup is explicit for saved companies and explains the HR rounding and credit rules', () => {
  const legacy = render();
  assert.match(legacy, /value="paid_days" selected=""/);
  assert.doesNotMatch(legacy, /Off-day \/ casual-leave credits/);
  const hourly = render({ policyData: { ...policy, calculation_mode: 'hourly_workings', credit_mode: 'earned', hours_per_day: 8.5 } });
  assert.match(hourly, /value="hourly_workings" selected=""/);
  assert.match(hourly, /Casual leave: 1 day at 20 actual working days/);
  assert.match(hourly, /rounded to 1 decimal/);
  assert.match(hourly, /Attendance<\/button>/);
  assert.doesNotMatch(hourly, /OT hourly multiplier|Deduct late hours at the calculated hourly rate/);
});

test('ordinary recorded version four registers with a null review reason remain exportable', () => {
  const snapshot = { ...register, schema_version: 4, bonus: 0, adjustment_incentive: 0, adjustment_deductions: 0,
    ledger_advance_recovery: 0, calculation_mode: 'hourly_workings', credit_mode: 'earned', attendance_source: 'recorded',
    attendance_reviewed: false, attendance_review_reason: null, worked_minutes: 11985, worked_hours: 199.75,
    credited_hours: 51, payable_hours: 250.75, other_paid_leave_days: 0, wages_roundoff: 1, net_roundoff: -.4, tds: 0,
    policy: { ...policy, calculation_mode: 'hourly_workings', hours_per_day: 8.5 } };
  const html = render({ step: 'review', rows: [{ id: 'slip', employee_id: employee.id, payroll_register: snapshot }] });
  assert.equal(buttonDisabled(html, 'Export Excel'), false);
  assert.match(html, /Hourly workings/);
  assert.match(html, /Recorded attendance/);
  assert.match(html, /Paid credit hours/);
  assert.match(html, /Payable hours/);
  assert.doesNotMatch(html.slice(html.indexOf('Payroll register ·')), /<th[^>]*>Ot Hours<\/th>/);
});
