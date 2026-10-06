import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { location: { href: 'http://127.0.0.1:5174/?qaPayroll=1&qa-role=super_admin' } };
const { payrollFixtures, payrollRpc } = await import('./payrollFixtures.js');
const { fixture, tables, period } = await import('./fixtures.js');
const originals = structuredClone({ inputs: tables.payroll_monthly_inputs, policies: tables.payroll_policies, runs: tables.payroll_runs });
beforeEach(() => {
  tables.payroll_monthly_inputs = structuredClone(originals.inputs);
  tables.payroll_policies = structuredClone(originals.policies);
  tables.payroll_runs = structuredClone(originals.runs);
});
const context = { allows: () => true, canWrite: true };
const batch = rows => payrollRpc('save_payroll_monthly_inputs', { _entity_id: 'company-1', _period: period, _rows: rows }, context);
const edit = (row, input = { incentive: '850' }) => ({ employee_id: row.employee_id, input, expected_updated_at: row.updated_at });

test('opt-in payroll fixture provides a full review register and both saved and unsaved employee rows', () => {
  assert.equal(payrollFixtures, true);
  assert.equal(tables.payroll_monthly_inputs.length, 160);
  assert.equal(fixture.employees.filter(person => person.entity_id === 'company-1').length, 175);
  assert.equal(tables.payslips.filter(row => row.run_id === 'qa-payroll-company-1').length, 175);
  assert.equal(tables.payroll_runs.find(row => row.id === 'qa-payroll-company-1').needs_recalculation, false);
});

test('atomic fixture saves return both revisions, mark the run stale and emit events after all rows commit', () => {
  const first = tables.payroll_monthly_inputs.slice(0, 2);
  const events = [];
  const result = payrollRpc('save_payroll_monthly_inputs', { _entity_id: 'company-1', _period: period,
    _rows: first.map(row => edit(row)) }, { ...context, event(table, kind, row) {
      events.push({ table, kind, row });
      assert.ok(first.every(original => tables.payroll_monthly_inputs.find(saved => saved.employee_id === original.employee_id).incentive === 850));
    } });
  assert.equal(result.error, undefined);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows.map(row => row.employee_id), first.map(row => row.employee_id));
  assert.ok(result.rows.every((row, index) => row.updated_at !== first[index].updated_at));
  assert.equal(tables.payroll_runs.find(row => row.id === 'qa-payroll-company-1').needs_recalculation, true);
  assert.deepEqual(events.map(event => event.table), ['payroll_monthly_inputs', 'payroll_monthly_inputs', 'payroll_runs']);
});

test('invalid or conflicting later rows leave every earlier employee and run unchanged', () => {
  const first = tables.payroll_monthly_inputs.slice(0, 2);
  const snapshot = structuredClone(tables.payroll_monthly_inputs);
  for (const badRow of [edit(first[1], { incentive: '-1' }), { ...edit(first[1]), expected_updated_at: null },
    edit(first[0]), { employee_id: fixture.employees[1].id, input: {}, expected_updated_at: null }]) {
    assert.ok(batch([edit(first[0]), badRow]).error);
    assert.deepEqual(tables.payroll_monthly_inputs, snapshot);
    assert.equal(tables.payroll_runs.find(row => row.id === 'qa-payroll-company-1').needs_recalculation, false);
  }
});

test('fixture preserves statutory null versus zero, creates absent rows, and rejects stale resubmissions', () => {
  const employee = fixture.employees.filter(person => person.entity_id === 'company-1').at(-1);
  const result = batch([{ employee_id: employee.id, expected_updated_at: null, input: { pf: '0', esi: '', notes: 'Reviewed sample override' } }]);
  assert.equal(result.rows[0].pf, 0);
  assert.equal(result.rows[0].esi, null);
  const stale = batch([{ employee_id: employee.id, expected_updated_at: null, input: {} }]);
  assert.equal(stale.error.code, '40001');
});

test('fixture enforces read-only published months and explicit blocked-write mode', () => {
  const first = tables.payroll_monthly_inputs[0];
  const request = { _entity_id: 'company-1', _period: period, _rows: [edit(first)] };
  assert.equal(payrollRpc('save_payroll_monthly_inputs', request, { ...context, canWrite: false }).error.code, '42501');
  assert.equal(payrollRpc('save_payroll_monthly_inputs', request, { ...context, allows: () => false }).error.code, '42501');
  tables.payroll_runs.find(row => row.id === 'qa-payroll-company-1').status = 'Published';
  assert.equal(payrollRpc('save_payroll_monthly_inputs', request, context).error.code, '55000');
});
