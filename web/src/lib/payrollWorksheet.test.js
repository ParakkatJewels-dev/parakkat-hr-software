import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {
  PAYROLL_REGISTER_COLUMNS, payrollRegisterColumns, monthlyInputDraft, normalizeMonthlyInput, payrollPolicyDraft,
  normalizePayrollPolicy, formatPayrollDayHours, isCompletePayrollRegister, payrollRegisterRows, buildPayrollWorkbook,
} from './payrollWorksheet.js';

const expectedLabels = ['Employee Name', 'Branch', 'Salary', 'No Of  Days Per Month', 'Net Working Days',
  'Public Holiday', 'Actual Working Days', 'Off Days', 'Casual Leave', 'Total Working Days',
  'Per Day Wages', 'Per Day Working Hour', 'Total Working Hours', 'Per Hour Wages', 'Salary',
  'Incentive', 'Target Incentive', 'Tea Expence', 'Other Allowances', 'Travel Allowance / Food Expence',
  'Rent / Commission', 'Special Allowances', 'Ot Hours', 'Ot Amount', 'late hours', 'Late Amount',
  'Gross Salary', 'Pf', 'Esi', 'Salary Advance Refund', 'Welfare Fund',
  'Deduction for loss and damages/ other deductions', 'Net Pay Salary'];

function snapshot() {
  return Object.fromEntries(PAYROLL_REGISTER_COLUMNS.map(({ key, type }, index) => [key,
    type === 'text' ? (key === 'employee_name' ? '=HYPERLINK("https://invalid.example")' : '@Branch') : String(index + 0.25)]));
}

test('the register preserves the supplied 33 columns and both distinct Salary positions', () => {
  assert.deepEqual(PAYROLL_REGISTER_COLUMNS.map(column => column.label), expectedLabels);
  assert.equal(new Set(PAYROLL_REGISTER_COLUMNS.map(column => column.key)).size, 33);
  const row = snapshot();
  row.salary = '30000'; row.earned_salary = '27000';
  const [values] = payrollRegisterRows([{ payroll_register: row }]);
  assert.equal(values[2], 30000);
  assert.equal(values[14], 27000);
});

test('Excel round-trip keeps duplicate headers, numeric amounts and formula-like names as literal text', () => {
  const workbook = buildPayrollWorkbook(XLSX, [{ payroll_register: snapshot() }]);
  const roundTrip = XLSX.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  const sheet = roundTrip.Sheets['Payroll register'];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  assert.deepEqual(rows[0], expectedLabels);
  assert.equal(sheet.A2.t, 's');
  assert.equal(sheet.A2.f, undefined);
  assert.equal(sheet.A2.v, '=HYPERLINK("https://invalid.example")');
  assert.equal(sheet.B2.v, '@Branch');
  assert.equal(sheet.C2.t, 'n');
  assert.equal(sheet.C2.v, 2.25);
  assert.equal(sheet.AH2, undefined);
});

test('missing legacy snapshots and malformed numeric values cannot become invented zeros in exports', () => {
  assert.equal(isCompletePayrollRegister(null), false);
  assert.throws(() => payrollRegisterRows([{ payroll_register: null }]), /snapshots/);
  for (const value of [null, undefined, '', ' ', 'NaN', 'Infinity', false, {}, []]) {
    assert.equal(isCompletePayrollRegister({ ...snapshot(), net_pay_salary: value }), false, String(value));
  }
  const incomplete = snapshot(); delete incomplete.pf;
  assert.throws(() => buildPayrollWorkbook(XLSX, [{ payroll_register: incomplete }]), /snapshots/);
});

test('transaction registers export a separate bonus without doubling totals already in incentive and deductions', () => {
  const row = { ...snapshot(), schema_version: 3, bonus: 1250.50, incentive: 600, adjustment_incentive: 100,
    other_deductions: 200, adjustment_deductions: 75, advance_recovery: 1500, ledger_advance_recovery: 1500 };
  const slips = [{ payroll_register: row }];
  const columns = payrollRegisterColumns(slips);
  assert.equal(columns.length, 34);
  const [values] = payrollRegisterRows(slips);
  assert.equal(values[columns.findIndex(column => column.key === 'bonus')], 1250.50);
  assert.equal(values[columns.findIndex(column => column.key === 'incentive')], 600);
  const workbook = buildPayrollWorkbook(XLSX, slips);
  const exported = XLSX.utils.sheet_to_json(workbook.Sheets['Payroll register'], { header: 1 });
  assert.equal(exported[0].filter(label => label === 'Bonus').length, 1);
  for (const key of ['bonus', 'adjustment_incentive', 'adjustment_deductions', 'ledger_advance_recovery']) {
    assert.equal(isCompletePayrollRegister({ ...row, [key]: undefined }), false);
    assert.throws(() => payrollRegisterRows([{ payroll_register: { ...row, [key]: -1 } }]), /snapshots/);
  }
});

test('blank statutory and hour inputs use configured components and attendance while explicit zero remains an override', () => {
  const defaults = normalizeMonthlyInput(monthlyInputDraft());
  assert.equal(defaults.pf, null);
  assert.equal(defaults.esi, null);
  assert.equal(defaults.ot_hours, null);
  assert.equal(defaults.late_hours, null);
  assert.equal(monthlyInputDraft().ot_hours, '');
  assert.equal(monthlyInputDraft().late_hours, '');
  const input = normalizeMonthlyInput({ ...monthlyInputDraft(), pf: '0', esi: '0.00', notes: 'Reviewed exemption for this month' });
  assert.equal(input.pf, 0);
  assert.equal(input.esi, 0);
  assert.equal(monthlyInputDraft({ pf: 0, esi: null }).pf, '0');
  assert.equal(monthlyInputDraft({ pf: 0, esi: null }).esi, '');
  assert.equal(monthlyInputDraft({ ot_hours: 0, late_hours: 1.25 }).ot_hours, '0', 'legacy numeric hours are retained');
  assert.equal(monthlyInputDraft({ ot_hours: 0, late_hours: 1.25 }).late_hours, '1.25');
});

test('hours require approval and monetary inputs reject invalid, negative or overprecise values', () => {
  const input = normalizeMonthlyInput({ ...monthlyInputDraft(), incentive: '1200.50', ot_hours: '2.25', notes: 'Reviewed attendance override' });
  assert.equal(input.incentive, 1200.5);
  assert.equal(input.ot_hours, 2.25);
  for (const value of ['-1', 'NaN', 'Infinity', '1e3', '0x10', '12.345', '1,000', '10000000000']) {
    assert.throws(() => normalizeMonthlyInput({ ...monthlyInputDraft(), incentive: value }), /Incentive/);
  }
  assert.throws(() => normalizeMonthlyInput({ ...monthlyInputDraft(), ot_hours: '744.01' }), /744/);
  assert.equal(normalizeMonthlyInput({ ...monthlyInputDraft(), ot_hours: null }).ot_hours, null);
});

test('hour, deduction and statutory overrides require a retained reason, including explicit zero', () => {
  for (const patch of [{ other_deductions: '50' }, { ot_hours: '2.25' }, { ot_hours: '0' }, { late_hours: '0' }, { late_hours: '0.25' }, { pf: '0' }, { esi: '50' }]) {
    assert.throws(() => normalizeMonthlyInput({ ...monthlyInputDraft(), ...patch, notes: '  ' }), /reason/);
    assert.equal(normalizeMonthlyInput({ ...monthlyInputDraft(), ...patch, notes: '  Approved correction  ' }).notes, 'Approved correction');
  }
  assert.doesNotThrow(() => normalizeMonthlyInput({ ot_hours: '', late_hours: null, pf: '', esi: null, notes: '' }));
});

test('policy validation supports each divisor but disallows zero hours and unsupported values', () => {
  for (const divisor_mode of ['calendar', 'fixed', 'working']) {
    assert.equal(normalizePayrollPolicy({ ...payrollPolicyDraft(), divisor_mode }).divisor_mode, divisor_mode);
  }
  assert.equal(normalizePayrollPolicy({ ...payrollPolicyDraft(), ot_multiplier: '0' }).ot_multiplier, 0);
  for (const patch of [{ divisor_mode: 'unknown' }, { hours_per_day: '0' }, { hours_per_day: '24.01' },
    { fixed_days: '0' }, { fixed_days: '32' }, { ot_multiplier: '-1' }, { ot_multiplier: '11' }]) {
    assert.throws(() => normalizePayrollPolicy({ ...payrollPolicyDraft(), ...patch }));
  }
});

test('daily working time suggests 8h 30m while preserving the meaning of saved decimal hours', () => {
  const draft = payrollPolicyDraft();
  assert.equal(draft.hours_per_day, '8.5');
  assert.equal(normalizePayrollPolicy(draft).hours_per_day, 8.5);
  assert.equal(formatPayrollDayHours(draft.hours_per_day), '8h 30m');
  for (const [hours, duration] of [[8, '8h 0m'], [8.3, '8h 18m'], [8.01, '8h 0m 36s'],
    [8.33, '8h 19m 48s'], [0.5, '0h 30m'], [24, '24h 0m']]) {
    const savedDraft = payrollPolicyDraft({ hours_per_day: hours });
    assert.equal(normalizePayrollPolicy(savedDraft).hours_per_day, hours, 'saved hours must not be reinterpreted');
    assert.equal(formatPayrollDayHours(savedDraft.hours_per_day), duration);
  }
  for (const invalid of [null, undefined, '', ' ', false, {}, 'NaN', Infinity, -8.5, 0, 24.5]) {
    assert.equal(formatPayrollDayHours(invalid), '—');
  }
});
