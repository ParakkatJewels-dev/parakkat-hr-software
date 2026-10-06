// The worksheet is a view of the database calculation, never a second salary engine.
// Keep labels in array order: object-based exports would rename the two Salary columns.
export const PAYROLL_REGISTER_COLUMNS = [
  ['employee_name', 'Employee Name', 'text'],
  ['branch', 'Branch', 'text'],
  ['salary', 'Salary', 'money'],
  ['days_per_month', 'No Of  Days Per Month', 'number'],
  ['net_working_days', 'Net Working Days', 'number'],
  ['public_holiday', 'Public Holiday', 'number'],
  ['actual_working_days', 'Actual Working Days', 'number'],
  ['off_days', 'Off Days', 'number'],
  ['casual_leave', 'Casual Leave', 'number'],
  ['total_working_days', 'Total Working Days', 'number'],
  ['per_day_wages', 'Per Day Wages', 'money'],
  ['per_day_working_hour', 'Per Day Working Hour', 'number'],
  ['total_working_hours', 'Total Working Hours', 'number'],
  ['per_hour_wages', 'Per Hour Wages', 'money'],
  ['earned_salary', 'Salary', 'money'],
  ['incentive', 'Incentive', 'money'],
  ['target_incentive', 'Target Incentive', 'money'],
  ['tea_expense', 'Tea Expence', 'money'],
  ['other_allowances', 'Other Allowances', 'money'],
  ['travel_food', 'Travel Allowance / Food Expence', 'money'],
  ['rent_commission', 'Rent / Commission', 'money'],
  ['special_allowance', 'Special Allowances', 'money'],
  ['ot_hours', 'Ot Hours', 'number'],
  ['ot_amount', 'Ot Amount', 'money'],
  ['late_hours', 'late hours', 'number'],
  ['late_amount', 'Late Amount', 'money'],
  ['gross_salary', 'Gross Salary', 'money'],
  ['pf', 'Pf', 'money'],
  ['esi', 'Esi', 'money'],
  ['advance_recovery', 'Salary Advance Refund', 'money'],
  ['welfare_fund', 'Welfare Fund', 'money'],
  ['other_deductions', 'Deduction for loss and damages/ other deductions', 'money'],
  ['net_pay_salary', 'Net Pay Salary', 'money'],
].map(([key, label, type]) => ({ key, label, type }));

export const MONTHLY_INPUT_FIELDS = [
  { key: 'incentive', label: 'Incentive', group: 'Earnings' },
  { key: 'target_incentive', label: 'Target incentive', group: 'Earnings' },
  { key: 'tea_expense', label: 'Tea expense', group: 'Earnings' },
  { key: 'other_allowances', label: 'Other allowances', group: 'Earnings' },
  { key: 'travel_food', label: 'Travel allowance / food expense', group: 'Earnings' },
  { key: 'rent_commission', label: 'Rent / commission', group: 'Earnings' },
  { key: 'special_allowance', label: 'Special allowances', group: 'Earnings' },
  { key: 'ot_hours', label: 'Approved OT hours', group: 'Hours' },
  { key: 'late_hours', label: 'Approved late hours', group: 'Hours' },
  { key: 'pf', label: 'PF', group: 'Deductions', nullable: true },
  { key: 'esi', label: 'ESI', group: 'Deductions', nullable: true },
  { key: 'advance_recovery', label: 'Salary advance refund', group: 'Deductions' },
  { key: 'welfare_fund', label: 'Welfare fund', group: 'Deductions' },
  { key: 'other_deductions', label: 'Loss / damage / other deductions', group: 'Deductions' },
];

export function monthlyInputDraft(row) {
  return Object.fromEntries([
    ...MONTHLY_INPUT_FIELDS.map(({ key, nullable }) => [key, row?.[key] == null ? (nullable ? '' : '0') : String(row[key])]),
    ['notes', row?.notes ?? ''],
  ]);
}

function nonnegativeDecimal(value, label, { nullable = false, max = 9999999999.99 } = {}) {
  const text = String(value ?? '').trim();
  if (!text) return nullable ? null : 0;
  // Do not accept hex, infinities, scientific notation or silently round a third decimal.
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(text)) {
    throw new Error(`${label} must be a nonnegative number with at most two decimal places.`);
  }
  const number = Number(text);
  if (!Number.isFinite(number) || number > max) throw new Error(`${label} must be no more than ${max}.`);
  return number;
}

export function normalizeMonthlyInput(draft) {
  const input = {};
  for (const field of MONTHLY_INPUT_FIELDS) {
    input[field.key] = nonnegativeDecimal(draft[field.key], field.label, {
      nullable: field.nullable,
      ...(field.group === 'Hours' ? { max: 744 } : {}),
    });
  }
  input.notes = String(draft.notes ?? '').trim();
  if ((input.other_deductions > 0 || input.late_hours > 0 || input.pf !== null || input.esi !== null) && !input.notes) {
    throw new Error('Record a reason for late deductions, other deductions or PF / ESI overrides.');
  }
  return input;
}

export function payrollPolicyDraft(row) {
  return {
    divisor_mode: row?.divisor_mode ?? 'calendar',
    fixed_days: String(row?.fixed_days ?? 30),
    hours_per_day: String(row?.hours_per_day ?? 8),
    ot_multiplier: String(row?.ot_multiplier ?? 2),
    deduct_late: row?.deduct_late ?? false,
    notes: row?.notes ?? '',
  };
}

export function normalizePayrollPolicy(draft) {
  if (!['calendar', 'fixed', 'working'].includes(draft.divisor_mode)) throw new Error('Choose a salary divisor.');
  const fixedDays = nonnegativeDecimal(draft.fixed_days, 'Fixed days', { max: 31 });
  const hours = nonnegativeDecimal(draft.hours_per_day, 'Hours per day', { max: 24 });
  const multiplier = nonnegativeDecimal(draft.ot_multiplier, 'OT multiplier', { max: 10 });
  if (fixedDays < 1) throw new Error('Fixed days must be between 1 and 31.');
  if (hours <= 0) throw new Error('Hours per day must be greater than zero.');
  return { divisor_mode: draft.divisor_mode, fixed_days: fixedDays, hours_per_day: hours,
    ot_multiplier: multiplier, deduct_late: Boolean(draft.deduct_late), notes: String(draft.notes ?? '').trim() };
}

export function isCompletePayrollRegister(row) {
  if (!row || typeof row !== 'object') return false;
  return PAYROLL_REGISTER_COLUMNS.every(({ key, type }) => {
    if (!Object.hasOwn(row, key)) return false;
    if (type === 'text') return typeof row[key] === 'string';
    return (typeof row[key] === 'number' || (typeof row[key] === 'string' && row[key].trim() !== ''))
      && Number.isFinite(Number(row[key]));
  });
}

export function payrollRegisterRows(payslips) {
  return payslips.map((payslip) => {
    if (!isCompletePayrollRegister(payslip.payroll_register)) {
      throw new Error('This run has missing or incomplete worksheet snapshots. Recalculate the draft before exporting.');
    }
    return PAYROLL_REGISTER_COLUMNS.map(({ key, type }) => type === 'text'
      ? payslip.payroll_register[key] : Number(payslip.payroll_register[key]));
  });
}

export function buildPayrollWorkbook(XLSX, payslips) {
  const rows = payrollRegisterRows(payslips);
  const worksheet = XLSX.utils.aoa_to_sheet([PAYROLL_REGISTER_COLUMNS.map(({ label }) => label), ...rows]);
  // Explicit text cells preserve employee names beginning with =, +, - or @ as literal text.
  // AOA also preserves the user's two distinct columns with identical Salary headers.
  for (let row = 0; row <= rows.length; row += 1) {
    PAYROLL_REGISTER_COLUMNS.forEach(({ type }, column) => {
      const cell = worksheet[XLSX.utils.encode_cell({ r: row, c: column })];
      if (row === 0 || type === 'text') {
        cell.t = 's';
        delete cell.f;
      } else cell.z = type === 'money' ? '#,##0.00' : '0.##';
    });
  }
  worksheet['!cols'] = PAYROLL_REGISTER_COLUMNS.map(({ key, type }) => ({ wch: key === 'employee_name' ? 28 : type === 'text' ? 20 : 19 }));
  worksheet['!autofilter'] = { ref: worksheet['!ref'] };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Payroll register');
  return workbook;
}

export async function exportPayrollRegister(payslips, company, period) {
  const XLSX = await import('xlsx');
  const workbook = buildPayrollWorkbook(XLSX, payslips);
  const safeCompany = String(company || 'company').replace(/[^a-zA-Z0-9_-]+/g, '-');
  XLSX.writeFile(workbook, `Payroll-${safeCompany}-${period}.xlsx`);
}
