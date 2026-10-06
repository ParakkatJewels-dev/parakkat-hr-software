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
  assert.equal(tables.payslips.filter(row => row.run_id === 'qa-payroll-company-1').length, 174);
  assert.equal(tables.payroll_runs.find(row => row.id === 'qa-payroll-company-1').employees, 174);
  assert.equal(tables.payslips.find(row => row.run_id === 'qa-payroll-company-1').payroll_register.recorded_deductible_late_hours, 0.25);
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

test('attendance summary fixture supplies live automatic hours, explicit zero sources and scope filtering', () => {
  const read = overrides => payrollRpc('get_payroll_attendance_summary', { _entity_id: 'company-1', _period: period }, { ...context, ...overrides });
  const result = read({ canWrite: false });
  assert.equal(result.rows.length, 175);
  assert.equal(result.rows[0].in_payroll_month, true);
  assert.equal(result.rows[0].recorded_ot_hours, 4);
  assert.equal(result.rows[0].effective_ot_hours, 2);
  assert.equal(result.rows[0].ot_source, 'override');
  assert.equal(result.rows[1].effective_ot_hours, result.rows[1].recorded_ot_hours);
  assert.equal(result.rows[1].ot_source, 'attendance');
  assert.equal(result.rows[1].effective_late_hours, 0);
  assert.equal(result.rows[1].policy_deduct_late, false);
  assert.ok(result.rows.some(row => row.unresolved_days > 0));
  assert.equal(result.rows[14].missing_days, 1);
  assert.equal(result.rows[14].unresolved_days, 0, 'missing records are not also counted as unresolved punch records');
  assert.equal(result.rows[18].invalid_days, 1);
  assert.equal(result.rows[18].unresolved_days, 0, 'invalid rows retain their separate diagnostic');
  assert.ok(result.rows.some(row => row.pending_recompute_days > 0));
  tables.payroll_policies[0].deduct_late = true;
  assert.equal(read().rows[1].effective_late_hours, read().rows[1].deductible_late_hours);
  assert.equal(read().rows[0].effective_late_hours, 0, 'an explicit zero late override stays zero when deductions are enabled');
  assert.equal(read().rows[0].late_source, 'override');
  assert.equal(read({ allows: (_permission, employee) => employee.employee_id === result.rows[1].employee_id }).rows.length, 1);
});

test('future-joining employees stay in the roster without current-month payroll hours or warnings', () => {
  const person = fixture.employees.filter(employee => employee.entity_id === 'company-1').at(-1);
  const summary = month => payrollRpc('get_payroll_attendance_summary', { _entity_id: 'company-1', _period: month }, context)
    .rows.find(row => row.employee_id === person.id);
  const saved = batch([{ employee_id: person.id, expected_updated_at: null,
    input: { ot_hours: 10, late_hours: 1, notes: 'Future month draft approval' } }]);
  assert.equal(saved.error, undefined);
  const row = summary(period);
  assert.equal(row.in_payroll_month, false);
  for (const key of ['expected_days', 'attendance_days', 'recorded_ot_hours', 'recorded_late_hours',
    'effective_ot_hours', 'effective_late_hours', 'missing_days', 'invalid_days', 'unresolved_days', 'pending_recompute_days']) {
    assert.equal(row[key], 0, key);
  }
  assert.equal(row.employment_from, person.join_date);
  assert.equal(row.ot_source, 'override');
  assert.equal(row.override_issue, null);
  assert.equal(row.employment_issue, null);
  assert.equal(row.first_punch_at, null);
  assert.equal(tables.payslips.some(slip => slip.run_id === 'qa-payroll-company-1' && slip.employee_id === person.id), false);
  const eligible = summary(person.join_date.slice(0, 7));
  assert.equal(eligible.in_payroll_month, true);
  assert.ok(eligible.expected_days > 0);
  assert.equal(eligible.ot_source, 'attendance', 'the previous month input does not carry into the joining month');
});

test('resetting a monthly override to null uses recorded attendance and cannot alter published snapshots', () => {
  const first = tables.payroll_monthly_inputs[0];
  const snapshot = structuredClone(tables.payslips.find(row => row.employee_id === first.employee_id && row.run_id === 'qa-payroll-company-1'));
  const zero = batch([edit(first, { ot_hours: 0, notes: 'Reviewed zero overtime' })]);
  assert.equal(zero.rows[0].ot_hours, 0);
  const reset = batch([edit(zero.rows[0], { ot_hours: null, late_hours: null })]);
  assert.equal(reset.rows[0].ot_hours, null);
  const summary = payrollRpc('get_payroll_attendance_summary', { _entity_id: 'company-1', _period: period }, context).rows[0];
  assert.equal(summary.ot_source, 'attendance');
  assert.equal(summary.effective_ot_hours, 4);
  assert.deepEqual(tables.payslips.find(row => row.id === snapshot.id), snapshot);
  tables.payroll_runs.find(row => row.id === 'qa-payroll-company-1').status = 'Published';
  assert.equal(batch([edit(reset.rows[0], { ot_hours: 0, notes: 'Cannot change published payroll' })]).error.code, '55000');
  assert.deepEqual(tables.payslips.find(row => row.id === snapshot.id), snapshot);
});

test('fixture hour overrides require reasons and expose recorded-hour cap issues after saving', () => {
  const first = tables.payroll_monthly_inputs[0];
  for (const input of [{ ot_hours: 0 }, { late_hours: 0 }, { ot_hours: 745, notes: 'Reviewed' }]) {
    assert.ok(batch([edit(first, input)]).error);
  }
  assert.equal(tables.payroll_monthly_inputs[0].updated_at, first.updated_at);
  const higher = batch([edit(first, { ot_hours: 4.01, notes: 'Attendance correction requested' })]);
  assert.equal(higher.error, undefined, 'production permits draft inputs; generation enforces the attendance cap');
  const summary = () => payrollRpc('get_payroll_attendance_summary', { _entity_id: 'company-1', _period: period }, context).rows[0];
  assert.equal(summary().override_issue, 'OT override exceeds recorded overtime.');
  const late = batch([edit(higher.rows[0], { late_hours: 0.5, notes: 'Late deduction review' })]);
  assert.equal(late.error, undefined);
  assert.equal(summary().override_issue, 'Late deductions are disabled by company policy.');
  tables.payroll_policies[0].deduct_late = true;
  assert.equal(summary().override_issue, 'Late override exceeds lateness on fully paid working days.');
});
