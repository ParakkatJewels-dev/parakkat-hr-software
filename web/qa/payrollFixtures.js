// Explicit local payroll-grid scenarios. These fixtures never calculate or write real payroll.
// PostgreSQL tests own authorization and transaction guarantees; this adapter exercises the UI.
import { fixture, tables, period, today } from './fixtures.js';
import { normalizeMonthlyInput, normalizePayrollPolicy } from '../src/lib/payrollWorksheet.js';
import { normalizePayrollAdjustment, normalizePayrollAdvance, normalizePayrollAdvanceRecovery,
  normalizePayrollPaymentStatus, normalizePayrollVoidReason } from '../src/lib/payrollTransactions.js';

export const payrollFixtures = typeof window !== 'undefined'
  && new URL(window.location.href).searchParams.get('qaPayroll') === '1';

if (payrollFixtures) {
  const entity = fixture.org.entities[0];
  const people = fixture.employees.filter(person => person.entity_id === entity.id);
  // Keep an employee in the roster whose future start excludes them from this month's run.
  const nextMonth = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 1));
  people.at(-1).join_date = nextMonth.toISOString().slice(0, 10);
  const stamp = `${today}T03:30:00.000Z`;
  const policy = { entity_id: entity.id, divisor_mode: 'fixed', fixed_days: 30, hours_per_day: 8,
    ot_multiplier: 2, deduct_late: false, notes: 'Synthetic reviewed policy for payroll grid QA.', updated_at: stamp };
  tables.payroll_policies = [policy];
  tables.payroll_monthly_inputs = people.slice(0, 160).map((person, index) => ({
    employee_id: person.id, period, entity_id: person.entity_id, zone_id: person.zone_id,
    branch_id: person.branch_id, department_id: person.department_id,
    ...normalizeMonthlyInput({ incentive: index % 3 === 0 ? 1250 : 0, target_incentive: index % 4 === 0 ? 750 : 0,
      tea_expense: 150, other_allowances: index % 7 === 0 ? 200 : 0, travel_food: index % 5 === 0 ? 500 : 0,
      rent_commission: 0, special_allowance: 0, ot_hours: index % 6 === 0 ? Math.min(2, [4, 1.5, 0, 2.25, 0.75][index % 5]) : null, late_hours: index % 9 === 0 ? 0 : null,
      pf: index === 1 ? 0 : null, esi: null, advance_recovery: index % 8 === 0 ? 500 : 0,
      welfare_fund: 20, other_deductions: 0, notes: index === 1 ? 'Synthetic reviewed PF override.'
        : index % 6 === 0 || index % 9 === 0 ? 'Synthetic reviewed hour override.' : '' }),
    updated_at: stamp,
  }));
  const inputs = new Map(tables.payroll_monthly_inputs.map(row => [row.employee_id, row]));
  const runId = 'qa-payroll-company-1';
  const publishedFixture = new URL(window.location.href).searchParams.get('qa-payroll-published') === '1';
  const transactionScope = person => ({ employee_id: person.id, entity_id: person.entity_id,
    zone_id: person.zone_id, branch_id: person.branch_id, department_id: person.department_id });
  tables.payroll_adjustments = ['bonus', 'incentive', 'deduction'].map((kind, index) => ({
    id: `qa-adjustment-${index}`, ...transactionScope(people[index]), period, kind,
    amount: [1000, 750, 250][index], reason: ['Festival bonus', 'Sales achievement', 'Approved uniform recovery'][index], updated_at: stamp,
  }));
  tables.payroll_advances = [{ id: 'qa-advance-1', ...transactionScope(people[1]), issued_on: `${period}-01`,
    amount: 5000, reason: 'Employee-requested salary advance', request_id: 'qa-advance-request-1', updated_at: stamp }];
  tables.payroll_advance_recoveries = [{ id: 'qa-recovery-1', advance_id: 'qa-advance-1', ...transactionScope(people[1]),
    period, amount: 1000, updated_at: stamp }];
  tables.payroll_payments = [];
  const dayCount = new Date(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0).getDate();
  const payslips = people.map((person, index) => {
    const input = inputs.get(person.id) ?? normalizeMonthlyInput({});
    const attendance = attendanceSummary(person, index, period, input, policy);
    if (!attendance.in_payroll_month) return null;
    const additions = ['incentive', 'target_incentive', 'tea_expense', 'other_allowances', 'travel_food', 'rent_commission', 'special_allowance']
      .reduce((total, key) => total + input[key], 0);
    const adjustments = tables.payroll_adjustments.filter(row => row.employee_id === person.id);
    const bonus = adjustments.filter(row => row.kind === 'bonus').reduce((total, row) => total + row.amount, 0);
    const incentive = adjustments.filter(row => row.kind === 'incentive').reduce((total, row) => total + row.amount, 0);
    const itemizedDeductions = adjustments.filter(row => row.kind === 'deduction').reduce((total, row) => total + row.amount, 0);
    const ledgerRecovery = tables.payroll_advance_recoveries.filter(row => row.employee_id === person.id).reduce((total, row) => total + row.amount, 0);
    const otAmount = attendance.effective_ot_hours * 250;
    const gross = 30000 + additions + otAmount + bonus + incentive;
    const pf = input.pf ?? 1800;
    const deductions = pf + input.advance_recovery + input.welfare_fund + input.other_deductions + itemizedDeductions + ledgerRecovery;
    return { id: `qa-payroll-payslip-${index}`, employee_id: person.id, employee: person,
      entity_id: entity.id, zone_id: person.zone_id, branch_id: person.branch_id, department_id: person.department_id,
      period, run_id: runId, status: publishedFixture ? 'Published' : 'Draft', gross, deductions, net: gross - deductions, paid_days: dayCount, lop_days: 0,
      payroll_register: { employee_name: person.full_name, branch: person.branch?.code ?? '', salary: 30000,
        days_per_month: dayCount, net_working_days: dayCount - 5, public_holiday: 1, actual_working_days: dayCount - 5,
        off_days: 4, casual_leave: 0, total_working_days: dayCount, per_day_wages: 1000, per_day_working_hour: 8,
        total_working_hours: attendance.recorded_worked_hours, per_hour_wages: 125, earned_salary: 30000,
        ...Object.fromEntries(['incentive', 'target_incentive', 'tea_expense', 'other_allowances', 'travel_food',
          'rent_commission', 'special_allowance', 'ot_hours', 'late_hours', 'advance_recovery', 'welfare_fund', 'other_deductions']
          .map(key => [key, input[key]])),
        ot_hours: attendance.effective_ot_hours, late_hours: attendance.effective_late_hours,
        ot_amount: otAmount, late_amount: 0, gross_salary: gross, pf, esi: 0, net_pay_salary: gross - deductions,
        bonus, adjustment_incentive: incentive, adjustment_deductions: itemizedDeductions, ledger_advance_recovery: ledgerRecovery,
        incentive: input.incentive + incentive, other_deductions: input.other_deductions + itemizedDeductions,
        advance_recovery: input.advance_recovery + ledgerRecovery,
        recorded_ot_hours: attendance.recorded_ot_hours, recorded_late_hours: attendance.recorded_late_hours,
        recorded_deductible_late_hours: attendance.deductible_late_hours, ot_source: attendance.ot_source, late_source: attendance.late_source, policy,
      } };
  }).filter(Boolean);
  tables.payslips = [...tables.payslips.filter(row => row.entity_id !== entity.id || row.period !== period), ...payslips];
  tables.payroll_runs = tables.payroll_runs.filter(row => row.entity_id !== entity.id || row.period !== period);
  tables.payroll_runs.push({ id: runId, entity_id: entity.id, entity, period, status: publishedFixture ? 'Published' : 'Draft', employees: payslips.length,
    needs_recalculation: false, source_fingerprint: 'qa-generation-1', created_at: stamp,
    total_gross: payslips.reduce((total, row) => total + row.gross, 0), total_net: payslips.reduce((total, row) => total + row.net, 0) });
  if (publishedFixture) tables.payroll_payments = payslips.map((slip, index) => ({
    run_id: runId, ...transactionScope(slip.employee), status: index === 0 ? 'held' : index === 1 ? 'paid' : 'unpaid',
    hold_reason: index === 0 ? 'Bank account confirmation pending' : null,
    paid_at: index === 1 ? stamp : null, payment_reference: index === 1 ? 'QA-BANK-001' : null, updated_at: stamp,
  }));
}

const TRANSACTION_WRITES = ['save_payroll_adjustment', 'delete_payroll_adjustment', 'create_payroll_advance',
  'save_payroll_advance_recovery', 'void_payroll_advance', 'set_payroll_payment_status'];
const WRITES = ['save_payroll_monthly_inputs', 'save_payroll_monthly_input', 'save_payroll_policy', ...TRANSACTION_WRITES];
const failure = (message, code = '22023') => ({ error: { message, code } });

export function payrollRpc(name, args, { allows, canWrite, event = () => {} }) {
  if (!payrollFixtures) return undefined;
  if (name === 'get_payroll_advance_recoveries') {
    if (!args._entity_id) return failure('Choose a company.');
    return { rows: tables.payroll_advance_recoveries.filter(row => row.entity_id === args._entity_id && allows('payroll.manage', row))
      .map(row => ({ ...row, posted: tables.payroll_runs.some(run => run.entity_id === row.entity_id && run.period === row.period && run.status === 'Published') })) };
  }
  if (name === 'get_payroll_attendance_summary') {
    if (!args._entity_id || !/^\d{4}-(0[1-9]|1[0-2])$/.test(args._period ?? '')) return failure('Choose a company and payroll month.');
    const policy = tables.payroll_policies.find(row => row.entity_id === args._entity_id);
    const people = fixture.employees.filter(person => person.entity_id === args._entity_id);
    const inputs = new Map(tables.payroll_monthly_inputs.filter(row => row.period === args._period).map(row => [row.employee_id, row]));
    return { rows: people.map((person, index) => ({ person, index }))
      .filter(({ person }) => allows('payroll.manage', { ...person, employee_id: person.id }))
      .map(({ person, index }) => attendanceSummary(person, index, args._period, inputs.get(person.id), policy)) };
  }
  if (!WRITES.includes(name)) return undefined;
  if (!canWrite) return failure('QA mode: this payroll write is intentionally blocked.', '42501');
  if (TRANSACTION_WRITES.includes(name)) return transactionRpc(name, args, { allows, event });
  if (name === 'save_payroll_policy') {
    if (!allows('payroll.manage', { entity_id: args._entity_id })) return failure('You cannot change this company’s payroll policy.', '42501');
    const current = tables.payroll_policies.find(row => row.entity_id === args._entity_id);
    if ((current?.updated_at ?? null) !== (args._expected_updated_at ?? null)) return failure('Policy changed. Reload its saved values before saving.', '40001');
    let policy;
    try { policy = normalizePayrollPolicy(args._policy); } catch (error) { return failure(error.message); }
    const next = { entity_id: args._entity_id, ...policy,
      updated_at: new Date(Math.max(Date.now(), Date.parse(current?.updated_at) || 0) + 1).toISOString() };
    tables.payroll_policies = [...tables.payroll_policies.filter(row => row.entity_id !== args._entity_id), next];
    event('payroll_policies', current ? 'UPDATE' : 'INSERT', next, current ?? {});
    markDrafts(args._entity_id, null, event);
    return { rows: [next], one: true, mutated: true };
  }

  const single = name === 'save_payroll_monthly_input';
  const person = single ? fixture.employees.find(row => row.id === args._employee_id) : null;
  const entityId = single ? person?.entity_id : args._entity_id;
  const rows = single ? [{ employee_id: args._employee_id, input: args._input, expected_updated_at: args._expected_updated_at }] : args._rows;
  if (!entityId || !/^\d{4}-(0[1-9]|1[0-2])$/.test(args._period ?? '')) return failure('Choose a company and payroll month.');
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 1000) return failure('Save between 1 and 1,000 payroll rows.');
  const run = tables.payroll_runs.find(row => row.entity_id === entityId && row.period === args._period);
  if (run && run.status !== 'Draft') return failure('Published payroll inputs are read-only.', '55000');

  const seen = new Set(), prepared = [];
  // Validate and stage the entire batch before touching any fixture table or emitting an event.
  for (const [index, row] of rows.entries()) {
    const employee = fixture.employees.find(candidate => candidate.id === row?.employee_id);
    if (!employee || employee.entity_id !== entityId || !allows('payroll.manage', { ...employee, employee_id: employee.id })) {
      return failure(`Row ${index + 1}: employee is outside your payroll scope.`, '42501');
    }
    if (seen.has(employee.id)) return failure(`Row ${index + 1}: employee appears more than once.`);
    seen.add(employee.id);
    const current = tables.payroll_monthly_inputs.find(saved => saved.employee_id === employee.id && saved.period === args._period);
    if ((current?.updated_at ?? null) !== (row.expected_updated_at ?? null)) {
      return failure(`Row ${index + 1}: saved values for ${employee.employee_code} changed. Reload them before saving.`, '40001');
    }
    let input;
    try { input = normalizeMonthlyInput(row.input); } catch (error) { return failure(`Row ${index + 1} (${employee.employee_code}): ${error.message}`); }
    if (input.advance_recovery > 0 && tables.payroll_advance_recoveries.some(recovery => recovery.employee_id === employee.id && recovery.period === args._period)) {
      return failure('Clear the tracked advance recovery before entering a manual recovery.');
    }
    const next = { employee_id: employee.id, period: args._period, entity_id: entityId, zone_id: employee.zone_id,
      branch_id: employee.branch_id, department_id: employee.department_id, ...input,
      updated_at: new Date(Math.max(Date.now(), Date.parse(current?.updated_at) || 0) + 1).toISOString() };
    prepared.push({ current, next });
  }
  tables.payroll_monthly_inputs = [...tables.payroll_monthly_inputs.filter(row => row.period !== args._period || !seen.has(row.employee_id)),
    ...prepared.map(row => row.next)];
  for (const { current, next } of prepared) event('payroll_monthly_inputs', current ? 'UPDATE' : 'INSERT', next, current ?? {});
  markDrafts(entityId, args._period, event);
  return { rows: prepared.map(row => row.next), one: single, mutated: true };
}

function attendanceSummary(employee, index, month, input, policy) {
  const days = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const monthFrom = `${month}-01`, monthTo = `${month}-${String(days).padStart(2, '0')}`;
  const employmentFrom = employee.join_date > monthFrom ? employee.join_date : monthFrom;
  const lastDay = tables.exits.filter(exit => exit.employee_id === employee.id
    && ['Cleared', 'Completed'].includes(exit.status) && exit.last_day >= (employee.join_date ?? '0001-01-01'))
    .map(exit => exit.last_day).sort()[0];
  const employmentTo = lastDay && lastDay < monthTo ? lastDay : monthTo;
  const inPayrollMonth = employmentFrom <= employmentTo;
  const metadata = { employee_id: employee.id, in_payroll_month: inPayrollMonth,
    ot_source: input?.ot_hours == null ? 'attendance' : 'override', late_source: input?.late_hours == null ? 'attendance' : 'override',
    employment_from: employmentFrom, employment_to: employmentTo, policy_deduct_late: Boolean(policy?.deduct_late), employment_issue: null };
  if (!inPayrollMonth) return { ...metadata, recorded_worked_hours: 0, recorded_ot_hours: 0,
    recorded_late_hours: 0, deductible_late_hours: 0, effective_ot_hours: 0, effective_late_hours: 0,
    attendance_days: 0, expected_days: 0, missing_days: 0, invalid_days: 0, unresolved_days: 0, pending_recompute_days: 0,
    first_punch_at: null, last_punch_at: null, computed_at: null, override_issue: null };
  const expectedDays = Math.round((Date.parse(employmentTo) - Date.parse(employmentFrom)) / 86400000) + 1;
  const missing = index % 29 === 14 ? 1 : 0;
  const invalid = index % 41 === 18 ? 1 : 0;
  const unresolved = index % 31 === 16 ? 1 : 0;
  const recordedOt = [4, 1.5, 0, 2.25, 0.75][index % 5];
  const recordedLate = [0.75, 1, 0, 0.25, 1.5][index % 5];
  const deductibleLate = index % 7 === 0 ? Math.round(recordedLate / 3 * 100) / 100 : recordedLate;
  const overrideIssue = input?.ot_hours > recordedOt ? 'OT override exceeds recorded overtime.'
    : input?.late_hours > 0 && !policy?.deduct_late ? 'Late deductions are disabled by company policy.'
      : input?.late_hours > deductibleLate ? 'Late override exceeds lateness on fully paid working days.' : null;
  return { ...metadata, recorded_worked_hours: Math.max(0, expectedDays - missing - invalid - 5) * 8,
    recorded_ot_hours: recordedOt, recorded_late_hours: recordedLate, deductible_late_hours: deductibleLate,
    effective_ot_hours: input?.ot_hours ?? recordedOt,
    effective_late_hours: policy?.deduct_late ? input?.late_hours ?? deductibleLate : 0,
    attendance_days: expectedDays - missing, expected_days: expectedDays, missing_days: missing, invalid_days: invalid,
    unresolved_days: unresolved, pending_recompute_days: index % 43 === 21 ? 1 : 0,
    first_punch_at: `${employmentFrom}T03:30:00.000Z`, last_punch_at: `${employmentTo}T13:00:00.000Z`,
    computed_at: `${today}T03:30:00.000Z`, override_issue: overrideIssue };
}

function markDrafts(entityId, month, event) {
  for (const run of tables.payroll_runs) {
    if (run.entity_id !== entityId || run.status !== 'Draft' || (month && run.period !== month)) continue;
    const previous = { ...run };
    run.needs_recalculation = true;
    event('payroll_runs', 'UPDATE', run, previous);
  }
}

function transactionRpc(name, args, { allows, event }) {
  const stamp = current => new Date(Math.max(Date.now(), Date.parse(current?.updated_at) || 0) + 1).toISOString();
  const scope = person => ({ employee_id: person.id, entity_id: person.entity_id,
    zone_id: person.zone_id, branch_id: person.branch_id, department_id: person.department_id });
  const authorized = person => person && allows('payroll.manage', { ...person, employee_id: person.id });
  const locked = (entityId, month) => tables.payroll_runs.some(run => run.entity_id === entityId && run.period === month && run.status !== 'Draft');
  const conflict = () => failure('This record changed. Reload its saved values before saving.', '40001');
  const denied = () => failure('Employee is outside your payroll scope.', '42501');
  const readOnly = () => failure('Published payroll entries are read-only.', '55000');
  const personFor = employeeId => fixture.employees.find(person => person.id === employeeId);
  const changed = (table, current, next) => {
    if (current) tables[table] = tables[table].filter(row => row !== current);
    if (next) tables[table].push(next);
    event(table, next ? current ? 'UPDATE' : 'INSERT' : 'DELETE', next ?? {}, current ?? {});
    return { rows: next ? [next] : [], one: true, mutated: true };
  };
  try {
    if (name === 'save_payroll_adjustment') {
      const person = personFor(args._employee_id);
      if (!authorized(person)) return denied();
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(args._period ?? '')) return failure('Choose a valid payroll month.');
      if (locked(person.entity_id, args._period)) return readOnly();
      const adjustment = normalizePayrollAdjustment(args._adjustment);
      const current = tables.payroll_adjustments.find(row => row.id === args._id);
      if (current && (current.employee_id !== person.id || current.period !== args._period)) return conflict();
      if (current && args._expected_updated_at == null && current.kind === adjustment.kind
          && current.amount === adjustment.amount && current.reason === adjustment.reason) return { rows: [current], one: true };
      if ((current?.updated_at ?? null) !== (args._expected_updated_at ?? null)) return conflict();
      const next = { id: args._id || crypto.randomUUID(), ...scope(person), period: args._period, ...adjustment, updated_at: stamp(current) };
      const result = changed('payroll_adjustments', current, next);
      markDrafts(person.entity_id, args._period, event);
      return result;
    }
    if (name === 'delete_payroll_adjustment') {
      const current = tables.payroll_adjustments.find(row => row.id === args._id);
      if (!current || !authorized(personFor(current.employee_id))) return denied();
      if (locked(current.entity_id, current.period)) return readOnly();
      if (current.updated_at !== args._expected_updated_at) return conflict();
      const result = changed('payroll_adjustments', current, null);
      markDrafts(current.entity_id, current.period, event);
      return result;
    }
    if (name === 'create_payroll_advance') {
      const person = personFor(args._employee_id);
      if (!authorized(person)) return denied();
      if (!args._request_id) return failure('A stable advance request ID is required.');
      const advance = normalizePayrollAdvance({ issuedOn: args._issued_on, amount: args._amount, reason: args._reason });
      const current = tables.payroll_advances.find(row => row.request_id === args._request_id);
      if (current) return current.employee_id === person.id && current.issued_on === advance.issuedOn
        && current.amount === advance.amount && current.reason === advance.reason ? { rows: [current], one: true } : conflict();
      return changed('payroll_advances', null, { id: crypto.randomUUID(), ...scope(person), request_id: args._request_id,
        issued_on: advance.issuedOn, amount: advance.amount, reason: advance.reason, updated_at: stamp() });
    }
    if (name === 'save_payroll_advance_recovery') {
      const advance = tables.payroll_advances.find(row => row.id === args._advance_id);
      if (!advance || !authorized(personFor(advance.employee_id))) return denied();
      if (advance.voided_at) return failure('Voided advances cannot be recovered.');
      const recovery = normalizePayrollAdvanceRecovery({ period: args._period, amount: args._amount });
      if (locked(advance.entity_id, recovery.period)) return readOnly();
      if (recovery.period < advance.issued_on.slice(0, 7)) return failure('Recovery cannot precede the advance issue month.');
      const current = tables.payroll_advance_recoveries.find(row => row.advance_id === advance.id && row.period === recovery.period);
      if ((current?.updated_at ?? null) !== (args._expected_updated_at ?? null)) return conflict();
      if (recovery.amount > 0 && tables.payroll_monthly_inputs.some(row => row.employee_id === advance.employee_id
          && row.period === recovery.period && row.advance_recovery > 0)) return failure('Clear the manual advance recovery before scheduling a tracked advance.');
      const otherCents = tables.payroll_advance_recoveries.filter(row => row.advance_id === advance.id && row !== current)
        .reduce((total, row) => total + Math.round(row.amount * 100), 0);
      if (otherCents + Math.round(recovery.amount * 100) > Math.round(advance.amount * 100)) return failure('Recovery exceeds the available advance balance.');
      const next = recovery.amount === 0 ? null : { id: current?.id ?? crypto.randomUUID(),
        ...scope(personFor(advance.employee_id)), advance_id: advance.id, ...recovery, updated_at: stamp(current) };
      const result = changed('payroll_advance_recoveries', current, next);
      markDrafts(advance.entity_id, recovery.period, event);
      return result;
    }
    if (name === 'void_payroll_advance') {
      const current = tables.payroll_advances.find(row => row.id === args._id);
      if (!current || !authorized(personFor(current.employee_id))) return denied();
      if (current.updated_at !== args._expected_updated_at) return conflict();
      if (current.voided_at) return failure('This advance is already voided.');
      const reason = normalizePayrollVoidReason(args._reason);
      if (tables.payroll_advance_recoveries.some(row => row.advance_id === current.id)) return failure('Clear recovery schedules before voiding the advance.');
      return changed('payroll_advances', current, { ...current, voided_at: stamp(current), void_reason: reason, updated_at: stamp(current) });
    }
    const run = tables.payroll_runs.find(row => row.id === args._run_id);
    const slip = tables.payslips.find(row => row.run_id === args._run_id && row.employee_id === args._employee_id);
    if (!run || !slip || !allows('payroll.manage', slip)) return denied();
    if (!['Published', 'Paid'].includes(run.status)) return failure('Publish payroll before recording payment status.');
    const payment = normalizePayrollPaymentStatus({ status: args._status, reason: args._reason, reference: args._reference });
    const current = tables.payroll_payments.find(row => row.run_id === args._run_id && row.employee_id === args._employee_id);
    if ((current?.updated_at ?? null) !== (args._expected_updated_at ?? null)) return conflict();
    if (current?.status === 'paid') return failure('Recorded payments cannot be changed.');
    if (current?.status === 'held' && payment.status === 'paid') return failure('Release the salary hold before recording payment.');
    return changed('payroll_payments', current, { run_id: run.id, ...scope(slip.employee), status: payment.status,
      hold_reason: payment.status === 'held' ? payment.reason : null, paid_at: payment.status === 'paid' ? stamp() : null,
      payment_reference: payment.status === 'paid' ? payment.reference : null, updated_at: stamp(current) });
  } catch (error) {
    return failure(error.message);
  }
}
