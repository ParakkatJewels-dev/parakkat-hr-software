import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const stubs = {
  '@tanstack/react-query': 'export const useQuery = x => x; export const useMutation = x => x; export const useQueryClient = () => globalThis.worksheetClient;',
  supabaseClient: 'export const supabase = { from: (...args) => globalThis.worksheetDb.from(...args), rpc: (...args) => globalThis.worksheetDb.rpc(...args) };',
};
registerHooks({
  resolve(specifier, context, next) {
    const key = specifier in stubs ? specifier : specifier.split('/').at(-1).replace(/\.js$/, '');
    if (stubs[key]) return { url: `data:text/javascript,${encodeURIComponent(stubs[key])}`, shortCircuit: true };
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const url = new URL(`${specifier}.js`, context.parentURL);
      if (existsSync(fileURLToPath(url))) return next(url.href, context);
    }
    return next(specifier, context);
  },
});

const { usePayrollPolicy, usePayrollMonthlyInput, usePayrollMonthlyInputs, usePayrollWorksheetRun, usePayrollRegister,
  useSavePayrollPolicy, useSavePayrollMonthlyInput, useSavePayrollMonthlyInputs } = await import('./payrollWorksheet.js');
const { usePublishPayroll } = await import('./payroll.js');

function readDb(rows, { error = null, failPage = false } = {}) {
  const calls = [];
  globalThis.worksheetDb = { from(table) {
    const filters = [], orders = [];
    let start = 0, end = Infinity, single = false;
    const query = {
      select() { return query; },
      eq(key, value) { filters.push([key, value]); return query; },
      order(key) { orders.push(key); return query; },
      range(from, to) { start = from; end = to; return query; },
      maybeSingle() { single = true; return query; },
      then(resolve, reject) {
        calls.push({ table, filters, orders, start });
        const selected = rows.filter(row => filters.every(([key, value]) => row[key] === value))
          .sort((a, b) => {
            for (const key of orders) {
              if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
            }
            return 0;
          }).slice(start, Math.min(end + 1, start + 11));
        return Promise.resolve(error || (failPage && start > 0)
          ? { data: null, error: error || new Error('Page read failed') }
          : { data: single ? selected[0] ?? null : selected, error: null }).then(resolve, reject);
      },
    };
    return query;
  } };
  return calls;
}

test('register queries load every row for exactly one run through server-imposed caps', async () => {
  const records = Array.from({ length: 122 }, (_, index) => ({ id: String(index).padStart(4, '0'), run_id: 'chosen-run' }));
  const calls = readDb([...records, { id: 'unrelated', run_id: 'other-run' }]);
  assert.deepEqual(await usePayrollRegister('chosen-run').queryFn(), records);
  assert.ok(calls.length > 10);
  assert.ok(calls.every(call => call.table === 'payslips' && call.orders.at(-1) === 'id'));
  assert.equal(usePayrollRegister(null).enabled, false);
  assert.equal(usePayrollRegister('chosen-run', { enabled: false }).enabled, false);
  readDb(records, { failPage: true });
  await assert.rejects(usePayrollRegister('chosen-run').queryFn(), /Page read failed/);
});

test('single-record reads preserve errors and scope company, employee and month', async () => {
  const rows = [
    { id: '1', entity_id: 'company', employee_id: 'employee', period: '2026-10', incentive: 100 },
    { id: '2', entity_id: 'other-company', employee_id: 'other-employee', period: '2026-09' },
  ];
  for (const hook of [() => usePayrollPolicy('company'), () => usePayrollMonthlyInput('employee', '2026-10'),
    () => usePayrollWorksheetRun('company', '2026-10')]) {
    readDb(rows);
    assert.deepEqual(await hook().queryFn(), rows[0]);
    readDb(rows, { error: new Error('Access denied') });
    await assert.rejects(hook().queryFn(), /Access denied/);
  }
  assert.equal(usePayrollPolicy('').enabled, false);
  assert.equal(usePayrollMonthlyInput('', '2026-10').enabled, false);
  assert.equal(usePayrollWorksheetRun('company', '').enabled, false);
});

test('input saves retain null versus zero semantics and refresh all affected calculation views', async () => {
  const calls = [], invalidations = [];
  globalThis.worksheetClient = { invalidateQueries: async ({ queryKey }) => { invalidations.push(queryKey[0]); } };
  globalThis.worksheetDb = { rpc: async (name, args) => { calls.push({ name, args }); return { data: 'saved', error: null }; } };
  const mutation = useSavePayrollMonthlyInput();
  await mutation.mutationFn({ employeeId: 'employee', period: '2026-10', expectedUpdatedAt: '2026-10-06T12:30:00Z', input: { pf: '0', esi: '', notes: 'Reviewed exemption' } });
  assert.equal(calls[0].name, 'save_payroll_monthly_input');
  assert.equal(calls[0].args._employee_id, 'employee');
  assert.equal(calls[0].args._period, '2026-10');
  assert.equal(calls[0].args._expected_updated_at, '2026-10-06T12:30:00Z');
  assert.equal(calls[0].args._input.pf, 0);
  assert.equal(calls[0].args._input.esi, null);
  await mutation.onSuccess();
  for (const key of ['payroll-monthly-input', 'payroll-monthly-inputs', 'payroll-worksheet-run', 'payroll-register', 'payroll-runs', 'payslips', 'payslip-lines']) assert.ok(invalidations.includes(key), key);
  await assert.rejects(mutation.mutationFn({ employeeId: 'employee', period: '2026-10', input: { incentive: '-10' } }), /Incentive/);
  assert.equal(calls.length, 1);
});

test('policy save submits reviewed settings and surfaces server failures', async () => {
  let captured;
  globalThis.worksheetClient = { invalidateQueries() {} };
  globalThis.worksheetDb = { rpc: async (name, args) => { captured = { name, args }; return { error: new Error('Published month is locked') }; } };
  await assert.rejects(useSavePayrollPolicy().mutationFn({ entityId: 'company', policy: {
    divisor_mode: 'fixed', fixed_days: '30', hours_per_day: '8', ot_multiplier: '2', deduct_late: false,
  } }), /locked/);
  assert.equal(captured.name, 'save_payroll_policy');
  assert.equal(captured.args._entity_id, 'company');
  assert.equal(captured.args._policy.fixed_days, 30);
  assert.equal(captured.args._expected_updated_at, null);
});

test('publication submits the reviewed generation and preserves a changed-draft rejection', async () => {
  let captured;
  globalThis.worksheetClient = { invalidateQueries() {} };
  globalThis.worksheetDb = { rpc: async (name, args) => {
    captured = { name, args };
    return { error: new Error('Payroll was recalculated after your review. Review the new draft.') };
  } };
  await assert.rejects(usePublishPayroll().mutationFn({ runId: 'reviewed-run', expectedFingerprint: 'reviewed-generation' }), /after your review/);
  assert.deepEqual(captured, { name: 'publish_payroll', args: { _run_id: 'reviewed-run', _expected_fingerprint: 'reviewed-generation' } });
});

test('monthly input grid loads the complete company/month using the actual composite primary key', async () => {
  const records = Array.from({ length: 124 }, (_, index) => ({ employee_id: `employee-${String(index).padStart(4, '0')}`,
    entity_id: 'company', period: '2026-10', incentive: index }));
  const calls = readDb([...records.toReversed(),
    { employee_id: 'other-company', entity_id: 'elsewhere', period: '2026-10' },
    { employee_id: 'earlier', entity_id: 'company', period: '2026-09' }]);
  assert.deepEqual(await usePayrollMonthlyInputs('company', '2026-10').queryFn(), records);
  assert.ok(calls.length > 10);
  assert.ok(calls.every(call => call.table === 'payroll_monthly_inputs' && call.orders.at(-1) === 'employee_id'));
  assert.equal(usePayrollMonthlyInputs('', '2026-10').enabled, false);
  assert.equal(usePayrollMonthlyInputs('company', '').enabled, false);
  assert.equal(usePayrollMonthlyInputs('company', '2026-10', { enabled: false }).enabled, false);
  readDb(records, { failPage: true });
  await assert.rejects(usePayrollMonthlyInputs('company', '2026-10').queryFn(), /Page read failed/);
});

test('bulk save normalizes every row before one atomic RPC and preserves each revision', async () => {
  const calls = [], invalidations = [];
  const saved = [{ employee_id: 'employee-1', updated_at: 'new-revision' }, { employee_id: 'employee-2', updated_at: 'new-revision' }];
  globalThis.worksheetClient = { invalidateQueries: async ({ queryKey }) => { invalidations.push(queryKey); } };
  globalThis.worksheetDb = { rpc: async (name, args) => { calls.push({ name, args }); return { data: saved, error: null }; } };
  const mutation = useSavePayrollMonthlyInputs();
  const rows = [
    { employeeId: 'employee-1', input: { incentive: '1250.50', pf: '', esi: '' }, expectedUpdatedAt: 'old-revision' },
    { employeeId: 'employee-2', input: { pf: '0', notes: 'Reviewed exemption' } },
  ];
  assert.deepEqual(await mutation.mutationFn({ entityId: 'company', period: '2026-10', rows }), saved);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'save_payroll_monthly_inputs');
  assert.equal(calls[0].args._entity_id, 'company');
  assert.equal(calls[0].args._period, '2026-10');
  assert.deepEqual(calls[0].args._rows.map(row => [row.employee_id, row.expected_updated_at, row.input.pf]), [
    ['employee-1', 'old-revision', null], ['employee-2', null, 0],
  ]);
  assert.equal(calls[0].args._rows[0].input.incentive, 1250.5);
  assert.equal(rows[0].input.incentive, '1250.50', 'normalizing must not mutate the editable grid draft');
  await mutation.onSuccess();
  for (const key of ['payroll-monthly-inputs', 'payroll-monthly-input', 'payroll-register', 'payroll-runs', 'payslips']) {
    assert.ok(invalidations.some(queryKey => queryKey[0] === key), key);
  }
  for (const invalidRows of [[], [rows[0], rows[0]], [rows[0], { employeeId: 'employee-2', input: { incentive: '-1' } }],
    [{ input: {} }], Array.from({ length: 1001 }, () => rows[0])]) {
    await assert.rejects(mutation.mutationFn({ entityId: 'company', period: '2026-10', rows: invalidRows }));
  }
  assert.equal(calls.length, 1, 'an invalid later row cannot allow an earlier row to reach the RPC');
});

test('bulk save failures refresh only the affected input revisions and company month', async () => {
  const invalidations = [];
  globalThis.worksheetClient = { invalidateQueries: async ({ queryKey }) => { invalidations.push(queryKey); } };
  globalThis.worksheetDb = { rpc: async () => ({ data: null, error: new Error('Row 2 was changed by another operator') }) };
  const mutation = useSavePayrollMonthlyInputs();
  const variables = { entityId: 'company', period: '2026-10', rows: [
    { employeeId: 'employee-1', input: {} }, { employeeId: 'employee-2', input: {} },
  ] };
  await assert.rejects(mutation.mutationFn(variables), /Row 2/);
  await mutation.onError(new Error('Conflict'), variables);
  assert.deepEqual(invalidations, [
    ['payroll-monthly-inputs', 'company', '2026-10'], ['payroll-worksheet-run', 'company', '2026-10'],
    ['payroll-monthly-input', 'employee-1', '2026-10'], ['payroll-monthly-input', 'employee-2', '2026-10'],
  ]);
});
