// Explicit local payroll-grid scenarios. These fixtures never calculate or write real payroll.
// PostgreSQL tests own authorization and transaction guarantees; this adapter exercises the UI.
import { fixture, tables, period, today } from './fixtures.js';
import { normalizeMonthlyInput, normalizePayrollPolicy } from '../src/lib/payrollWorksheet.js';

export const payrollFixtures = typeof window !== 'undefined'
  && new URL(window.location.href).searchParams.get('qaPayroll') === '1';

if (payrollFixtures) {
  const entity = fixture.org.entities[0];
  const people = fixture.employees.filter(person => person.entity_id === entity.id);
  const stamp = `${today}T03:30:00.000Z`;
  const policy = { entity_id: entity.id, divisor_mode: 'fixed', fixed_days: 30, hours_per_day: 8,
    ot_multiplier: 2, deduct_late: false, notes: 'Synthetic reviewed policy for payroll grid QA.', updated_at: stamp };
  tables.payroll_policies = [policy];
  tables.payroll_monthly_inputs = people.slice(0, 160).map((person, index) => ({
    employee_id: person.id, period, entity_id: person.entity_id, zone_id: person.zone_id,
    branch_id: person.branch_id, department_id: person.department_id,
    ...normalizeMonthlyInput({ incentive: index % 3 === 0 ? 1250 : 0, target_incentive: index % 4 === 0 ? 750 : 0,
      tea_expense: 150, other_allowances: index % 7 === 0 ? 200 : 0, travel_food: index % 5 === 0 ? 500 : 0,
      rent_commission: 0, special_allowance: 0, ot_hours: index % 6 === 0 ? 2 : 0, late_hours: 0,
      pf: index === 1 ? 0 : null, esi: null, advance_recovery: index % 8 === 0 ? 500 : 0,
      welfare_fund: 20, other_deductions: 0, notes: index === 1 ? 'Synthetic reviewed PF override.' : '' }),
    updated_at: stamp,
  }));
  const inputs = new Map(tables.payroll_monthly_inputs.map(row => [row.employee_id, row]));
  const runId = 'qa-payroll-company-1';
  const dayCount = new Date(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0).getDate();
  const payslips = people.map((person, index) => {
    const input = inputs.get(person.id) ?? normalizeMonthlyInput({});
    const additions = ['incentive', 'target_incentive', 'tea_expense', 'other_allowances', 'travel_food', 'rent_commission', 'special_allowance']
      .reduce((total, key) => total + input[key], 0);
    const otAmount = input.ot_hours * 250;
    const gross = 30000 + additions + otAmount;
    const pf = input.pf ?? 1800;
    const deductions = pf + input.advance_recovery + input.welfare_fund + input.other_deductions;
    return { id: `qa-payroll-payslip-${index}`, employee_id: person.id, employee: person,
      entity_id: entity.id, zone_id: person.zone_id, branch_id: person.branch_id, department_id: person.department_id,
      period, run_id: runId, status: 'Draft', gross, deductions, net: gross - deductions, paid_days: dayCount, lop_days: 0,
      payroll_register: { employee_name: person.full_name, branch: person.branch?.code ?? '', salary: 30000,
        days_per_month: dayCount, net_working_days: dayCount - 5, public_holiday: 1, actual_working_days: dayCount - 5,
        off_days: 4, casual_leave: 0, total_working_days: dayCount, per_day_wages: 1000, per_day_working_hour: 8,
        total_working_hours: (dayCount - 5) * 8, per_hour_wages: 125, earned_salary: 30000,
        ...Object.fromEntries(['incentive', 'target_incentive', 'tea_expense', 'other_allowances', 'travel_food',
          'rent_commission', 'special_allowance', 'ot_hours', 'late_hours', 'advance_recovery', 'welfare_fund', 'other_deductions']
          .map(key => [key, input[key]])),
        ot_amount: otAmount, late_amount: 0, gross_salary: gross, pf, esi: 0, net_pay_salary: gross - deductions,
        recorded_ot_hours: 4, recorded_late_hours: 1, policy,
      } };
  });
  tables.payslips = [...tables.payslips.filter(row => row.entity_id !== entity.id || row.period !== period), ...payslips];
  tables.payroll_runs = tables.payroll_runs.filter(row => row.entity_id !== entity.id || row.period !== period);
  tables.payroll_runs.push({ id: runId, entity_id: entity.id, entity, period, status: 'Draft', employees: people.length,
    needs_recalculation: false, source_fingerprint: 'qa-generation-1', created_at: stamp,
    total_gross: payslips.reduce((total, row) => total + row.gross, 0), total_net: payslips.reduce((total, row) => total + row.net, 0) });
}

const WRITES = ['save_payroll_monthly_inputs', 'save_payroll_monthly_input', 'save_payroll_policy'];
const failure = (message, code = '22023') => ({ error: { message, code } });

export function payrollRpc(name, args, { allows, canWrite, event = () => {} }) {
  if (!payrollFixtures || !WRITES.includes(name)) return undefined;
  if (!canWrite) return failure('QA mode: this payroll write is intentionally blocked.', '42501');
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
    if (input.ot_hours > 4 || input.late_hours > 1) return failure(`Row ${index + 1}: approved hours exceed recorded QA attendance.`);
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

function markDrafts(entityId, month, event) {
  for (const run of tables.payroll_runs) {
    if (run.entity_id !== entityId || run.status !== 'Draft' || (month && run.period !== month)) continue;
    const previous = { ...run };
    run.needs_recalculation = true;
    event('payroll_runs', 'UPDATE', run, previous);
  }
}
