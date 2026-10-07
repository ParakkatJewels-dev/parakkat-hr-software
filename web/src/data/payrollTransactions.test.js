import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const stubs = {
  '@tanstack/react-query': 'export const useQuery = x => x; export const useMutation = x => x; export const useQueryClient = () => globalThis.transactionClient;',
  supabaseClient: 'export const supabase = { from: (...args) => globalThis.transactionDb.from(...args), rpc: (...args) => globalThis.transactionDb.rpc(...args) };',
};
registerHooks({ resolve(specifier, context, next) {
  const key = specifier in stubs ? specifier : specifier.split('/').at(-1).replace(/\.js$/, '');
  if (stubs[key]) return { url: `data:text/javascript,${encodeURIComponent(stubs[key])}`, shortCircuit: true };
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(`${specifier}.js`, context.parentURL);
    if (existsSync(fileURLToPath(url))) return next(url.href, context);
  }
  return next(specifier, context);
} });
const hooks = await import('./payrollTransactions.js');

function readDb(rows, errorPage = false) {
  const calls = [];
  globalThis.transactionDb = { from(table) {
    const filters = [], orders = [];
    let offset = 0;
    const query = { select() { return query; }, eq(key, value) { filters.push([key, value]); return query; },
      order(key) { orders.push(key); return query; }, range(start) { offset = start; return query; },
      then(resolve, reject) {
        calls.push({ table, filters, orders, offset });
        const data = rows.filter(row => filters.every(([key, value]) => row[key] === value)).sort((a, b) => {
          for (const key of orders) if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
          return 0;
        }).slice(offset, offset + 3);
        return Promise.resolve(errorPage && offset > 0 ? { data: null, error: new Error('Read failed') } : { data, error: null }).then(resolve, reject);
      } };
    return query;
  } };
  return calls;
}

test('transaction lists and payment composite keys load beyond server caps without crossing company or month', async () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({ id: String(index).padStart(3, '0'),
    employee_id: `employee-${String(index).padStart(3, '0')}`, entity_id: 'company', period: '2026-10', run_id: 'run' }));
  const reads = [
    [() => hooks.usePayrollAdjustments('company', '2026-10'), 'payroll_adjustments'],
    [() => hooks.usePayrollAdvances('company'), 'payroll_advances'],
    [() => hooks.usePayrollPayments('run'), 'payroll_payments'],
  ];
  for (const [hook, table] of reads) {
    const calls = readDb([...rows, { id: 'elsewhere', employee_id: 'other', entity_id: 'other', period: '2026-09', run_id: 'other' }]);
    assert.deepEqual(await hook().queryFn(), rows);
    assert.ok(calls.length > 3);
    assert.ok(calls.every(call => call.table === table));
    readDb(rows, true);
    await assert.rejects(hook().queryFn(), /Read failed/);
  }
  readDb(rows.map(({ id: _id, ...row }) => row));
  assert.equal((await hooks.usePayrollPayments('run').queryFn()).length, rows.length, 'payment rows do not have a single id column');
  assert.equal(hooks.usePayrollPayments('').enabled, false);
  assert.equal(hooks.usePayrollAdvances('company', { enabled: false }).enabled, false);
  assert.equal(hooks.usePayrollAdjustments('company', '').enabled, false);
});

test('recovery reads retain server publication state for branch managers without company run access', async () => {
  const rows = Array.from({ length: 1005 }, (_, index) => ({ id: `recovery-${index}`, posted: index % 2 === 0 }));
  const calls = [];
  globalThis.transactionDb = { rpc: async (name, args) => { calls.push({ name, args }); return { data: rows, error: null }; } };
  assert.deepEqual(await hooks.usePayrollAdvanceRecoveries('company').queryFn(), rows);
  assert.deepEqual(calls, [{ name: 'get_payroll_advance_recoveries', args: { _entity_id: 'company' } }]);
  assert.equal(hooks.usePayrollAdvanceRecoveries('').enabled, false);
  for (const value of [null, undefined, {}, '']) {
    globalThis.transactionDb = { rpc: async () => ({ data: value, error: null }) };
    await assert.rejects(hooks.usePayrollAdvanceRecoveries('company').queryFn(), /could not be loaded/);
  }
  globalThis.transactionDb = { rpc: async () => ({ data: null, error: new Error('Access denied') }) };
  await assert.rejects(hooks.usePayrollAdvanceRecoveries('company').queryFn(), /Access denied/);
});

test('new financial entries preserve the caller’s stable request IDs and optimistic versions', async () => {
  const calls = [];
  globalThis.transactionClient = { invalidateQueries: async () => {} };
  globalThis.transactionDb = { rpc: async (name, args) => { calls.push({ name, args }); return { data: args, error: null }; } };
  const adjustment = { employeeId: 'employee', period: '2026-10', id: 'stable-adjustment',
    adjustment: { kind: 'bonus', amount: '150.50', reason: '  Approved  ' } };
  await hooks.useSavePayrollAdjustment().mutationFn(adjustment);
  await hooks.useSavePayrollAdjustment().mutationFn(adjustment);
  assert.deepEqual(calls[0], { name: 'save_payroll_adjustment', args: { _employee_id: 'employee', _period: '2026-10',
    _id: 'stable-adjustment', _adjustment: { kind: 'bonus', amount: 150.5, reason: 'Approved' }, _expected_updated_at: null } });
  assert.deepEqual(calls[1], calls[0]);
  const advance = { employeeId: 'employee', issuedOn: '2026-10-07', amount: '500.00', reason: 'Request', requestId: 'stable-request' };
  await hooks.useCreatePayrollAdvance().mutationFn(advance);
  await hooks.useCreatePayrollAdvance().mutationFn(advance);
  assert.equal(calls[2].args._request_id, 'stable-request');
  assert.deepEqual(calls[3], calls[2]);
  await hooks.useSavePayrollAdvanceRecovery().mutationFn({ advanceId: 'advance', period: '2026-10', amount: 0, expectedUpdatedAt: 'saved-version' });
  assert.deepEqual(calls[4].args, { _advance_id: 'advance', _period: '2026-10', _amount: 0, _expected_updated_at: 'saved-version' });
  await hooks.useDeletePayrollAdjustment().mutationFn({ id: 'adjustment', expectedUpdatedAt: 'saved-version' });
  assert.deepEqual(calls[5].args, { _id: 'adjustment', _expected_updated_at: 'saved-version' });
  await hooks.useVoidPayrollAdvance().mutationFn({ id: 'advance', reason: '  Entered twice  ', expectedUpdatedAt: 'advance-version' });
  assert.deepEqual(calls[6].args, { _id: 'advance', _reason: 'Entered twice', _expected_updated_at: 'advance-version' });
});

test('payment recording passes the selected employee, published run and review version without modifying earned pay', async () => {
  const calls = [];
  globalThis.transactionClient = { invalidateQueries: async () => {} };
  globalThis.transactionDb = { rpc: async (name, args) => { calls.push({ name, args }); return { data: args, error: null }; } };
  await hooks.useSetPayrollPaymentStatus().mutationFn({ runId: 'run', employeeId: 'employee', status: 'paid', reference: ' BANK-42 ', expectedUpdatedAt: 'reviewed-version' });
  assert.deepEqual(calls, [{ name: 'set_payroll_payment_status', args: { _run_id: 'run', _employee_id: 'employee', _status: 'paid',
    _reason: null, _reference: 'BANK-42', _expected_updated_at: 'reviewed-version' } }]);
  await assert.rejects(hooks.useSetPayrollPaymentStatus().mutationFn({ runId: 'run', employeeId: 'employee', status: 'paid' }), /reference/);
  await assert.rejects(hooks.useCreatePayrollAdvance().mutationFn({ employeeId: 'employee', issuedOn: '2026-10-07', amount: 10, reason: 'Request' }), /request ID/);
  assert.equal(calls.length, 1, 'incomplete financial records do not reach the backend');
});

test('all transaction writes retain server rejection and await refreshing every affected view', async () => {
  const hooksToTest = [hooks.useSavePayrollAdjustment, hooks.useDeletePayrollAdjustment, hooks.useCreatePayrollAdvance,
    hooks.useSavePayrollAdvanceRecovery, hooks.useVoidPayrollAdvance, hooks.useSetPayrollPaymentStatus];
  for (const hook of hooksToTest) {
    const invalidations = [], pending = [];
    globalThis.transactionClient = { invalidateQueries: ({ queryKey }) => {
      invalidations.push(queryKey[0]);
      return new Promise(resolve => pending.push(resolve));
    } };
    const mutation = hook();
    let settled = false;
    const done = mutation.onSuccess().then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    for (const key of ['payroll-adjustments', 'payroll-advances', 'payroll-advance-recoveries', 'payroll-payments',
      'payroll-worksheet-run', 'payroll-register', 'payroll-runs', 'payslips']) assert.ok(invalidations.includes(key), key);
    pending.forEach(resolve => resolve());
    await done;
  }
  globalThis.transactionDb = { rpc: async () => ({ data: null, error: new Error('Recovery balance changed') }) };
  await assert.rejects(hooks.useSavePayrollAdvanceRecovery().mutationFn({ advanceId: 'advance', period: '2026-10', amount: 10 }), /balance changed/);
});
