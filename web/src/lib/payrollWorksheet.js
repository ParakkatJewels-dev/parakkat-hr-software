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

// Preserve historical exports; new registers show bonus explicitly instead of hiding it
// inside another allowance. Incentive/deduction/recovery columns already contain totals.
export function payrollRegisterColumns(payslips) {
  const columns = [...PAYROLL_REGISTER_COLUMNS];
  if (payslips.some(row => Object.hasOwn(row.payroll_register ?? {}, 'bonus'))) columns.splice(columns.findIndex(column => column.key === 'gross_salary'), 0, { key: 'bonus', label: 'Bonus', type: 'money' });
  if (payslips.some(row => Number(row.payroll_register?.schema_version) >= 4)) {
    const calendarDays = columns.findIndex(column => column.key === 'net_working_days');
    columns[calendarDays] = { ...columns[calendarDays], label: 'Recorded calendar working days' };
    const workedHours = columns.findIndex(column => column.key === 'total_working_hours');
    columns[workedHours] = { ...columns[workedHours], label: 'Worked hours (decimal)' };
    columns.splice(columns.findIndex(column => column.key === 'welfare_fund'), 0, { key: 'tds', label: 'TDS', type: 'money' });
    columns.push(...HOURLY_REGISTER_COLUMNS);
  }
  if (payslips.some(row => row.payroll_register?.shift_basis === 'assigned_shift')) columns.push(
    { key: 'undated_credit_days', label: 'Credits paid by day', type: 'number' },
    { key: 'undated_credit_amount', label: 'Day-credit amount', type: 'money' },
  );
  return columns;
}

export const HOURLY_REGISTER_COLUMNS = [
  ['calculation_mode', 'Calculation method', 'text'], ['attendance_source', 'Attendance source', 'text'],
  ['credit_mode', 'Paid credit rule', 'text'],
  ['credited_hours', 'Paid credit hours (decimal)', 'number'], ['payable_hours', 'Payable hours (decimal)', 'number'],
  ['other_paid_leave_days', 'Other paid leave days', 'number'],
  ['wages_roundoff', 'Wages round-off', 'money'], ['net_roundoff', 'Net round-off', 'money'],
  ['attendance_review_reason', 'Attendance review reason', 'text'],
].map(([key, label, type]) => ({ key, label, type }));

export const MONTHLY_INPUT_FIELDS = [
  { key: 'incentive', label: 'Incentive', group: 'Earnings' },
  { key: 'target_incentive', label: 'Target incentive', group: 'Earnings' },
  { key: 'tea_expense', label: 'Tea expense', group: 'Earnings' },
  { key: 'other_allowances', label: 'Other allowances', group: 'Earnings' },
  { key: 'travel_food', label: 'Travel allowance / food expense', group: 'Earnings' },
  { key: 'rent_commission', label: 'Rent / commission', group: 'Earnings' },
  { key: 'special_allowance', label: 'Special allowances', group: 'Earnings' },
  { key: 'ot_hours', label: 'OT hours', group: 'Hours', nullable: true, auto: true },
  { key: 'late_hours', label: 'Late hours', group: 'Hours', nullable: true, auto: true },
  { key: 'pf', label: 'PF', group: 'Deductions', nullable: true },
  { key: 'esi', label: 'ESI', group: 'Deductions', nullable: true },
  { key: 'advance_recovery', label: 'Salary advance refund', group: 'Deductions' },
  { key: 'tds', label: 'TDS', group: 'Deductions', nullable: true },
  { key: 'welfare_fund', label: 'Welfare fund', group: 'Deductions' },
  { key: 'other_deductions', label: 'Loss / damage / other deductions', group: 'Deductions' },
  { key: 'attendance_source', label: 'Attendance source', group: 'Attendance', type: 'source' },
  { key: 'worked_minutes', label: 'Reviewed worked time', group: 'Attendance', type: 'duration', nullable: true },
  { key: 'actual_working_days', label: 'Reviewed actual working days', group: 'Attendance', nullable: true },
  { key: 'public_holiday_days', label: 'Reviewed public holiday days', group: 'Attendance', nullable: true },
  { key: 'off_days', label: 'Approved off days', group: 'Attendance', nullable: true, auto: true },
  { key: 'casual_leave_days', label: 'Approved casual leave days', group: 'Attendance', nullable: true, auto: true },
];

export function monthlyInputDraft(row) {
  return Object.fromEntries([
    ...MONTHLY_INPUT_FIELDS.map(({ key, nullable, type }) => [key, type === 'source' ? row?.[key] ?? 'recorded' : type === 'duration' ? (typeof row?.[key] === 'string' && row[key].includes(':') ? row[key] : formatPayrollMinutes(row?.[key])) : row?.[key] == null ? (nullable ? '' : '0') : String(row[key])]),
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

export function formatPayrollMinutes(minutes) {
  if (minutes == null || minutes === '') return '';
  const value = Number(minutes);
  return Number.isInteger(value) && value >= 0 ? `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}` : String(minutes);
}

export function parsePayrollWorkedTime(value) {
  if (value == null || String(value).trim() === '') return null;
  // Numbers are already normalized API minutes; users and imports enter unambiguous H:MM.
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 44640) return value;
  const match = /^(\d{1,3}):([0-5]\d)$/.exec(String(value).trim());
  if (!match || Number(match[1]) * 60 + Number(match[2]) > 44640) throw new Error('Reviewed worked time must use H:MM, up to 744:00 (for example, 199:45).');
  return Number(match[1]) * 60 + Number(match[2]);
}

export function normalizeMonthlyInput(draft, { validateAttendance = true, calculationMode, creditMode } = {}) {
  const input = {};
  for (const field of MONTHLY_INPUT_FIELDS) {
    if (field.type === 'source') {
      input[field.key] = draft[field.key] ?? 'recorded';
      if (!['recorded', 'reviewed'].includes(input[field.key])) throw new Error('Choose recorded attendance or HR-reviewed monthly totals.');
      continue;
    }
    if (field.type === 'duration') { input[field.key] = parsePayrollWorkedTime(draft[field.key]); continue; }
    input[field.key] = nonnegativeDecimal(draft[field.key], field.label, {
      nullable: field.nullable,
      ...(field.group === 'Hours' ? { max: 744 } : field.group === 'Attendance' ? { max: 31 } : {}),
    });
  }
  input.notes = String(draft.notes ?? '').trim();
  if (validateAttendance) {
    if (input.attendance_source === 'reviewed') {
      if (calculationMode === 'paid_days') throw new Error('HR-reviewed monthly totals require the hourly workings calculation method.');
      if (['worked_minutes', 'actual_working_days', 'public_holiday_days'].some(key => input[key] == null)) throw new Error('Enter reviewed worked time, actual working days and public holiday days (including zero).');
      if (creditMode === 'attendance' && (input.off_days == null || input.casual_leave_days == null)) throw new Error('HR-reviewed totals using attendance credits require explicit off days and casual leave days, including zeroes.');
    } else if (['worked_minutes', 'actual_working_days', 'public_holiday_days'].some(key => input[key] != null)) throw new Error('Choose HR-reviewed totals to enter monthly worked time or day totals.');
    if (calculationMode === 'hourly_workings' && (input.ot_hours > 0 || input.late_hours > 0)) throw new Error('Hourly workings already pays all worked hours. Clear separate OT / late overrides.');
  }
  if ((input.attendance_source === 'reviewed' || input.off_days !== null || input.casual_leave_days !== null || input.tds !== null || input.other_deductions > 0 || input.ot_hours !== null || input.late_hours !== null || input.pf !== null || input.esi !== null) && !input.notes) {
    throw new Error('Record a reason for reviewed attendance, paid credit overrides, TDS, other deductions or OT / late / PF / ESI overrides.');
  }
  return input;
}

export function payrollPolicyDraft(row) {
  return {
    calculation_mode: row?.calculation_mode ?? (row ? 'paid_days' : 'hourly_workings'),
    credit_mode: row?.credit_mode ?? (row ? 'attendance' : 'earned'),
    divisor_mode: row?.divisor_mode ?? 'calendar',
    fixed_days: String(row?.fixed_days ?? 30),
    hours_per_day: String(row?.hours_per_day ?? 8.5),
    ot_multiplier: String(row?.ot_multiplier ?? 2),
    deduct_late: row?.deduct_late ?? false,
    notes: row?.notes ?? '',
  };
}

// Payroll stores decimal hours. Keep saved values exact: 8.3 is 8h 18m,
// and hundredths of an hour can include seconds (8.01 is 8h 0m 36s).
export function formatPayrollDayHours(value) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return '—';
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) return '—';
  const totalSeconds = Math.round(hours * 3600);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const seconds = totalSeconds % 60;
  return `${Math.floor(totalSeconds / 3600)}h ${minutes}m${seconds ? ` ${seconds}s` : ''}`;
}

export function normalizePayrollPolicy(draft) {
  const calculationMode = draft.calculation_mode ?? 'paid_days';
  const creditMode = draft.credit_mode ?? 'attendance';
  if (!['paid_days', 'hourly_workings'].includes(calculationMode)) throw new Error('Choose a payroll calculation method.');
  if (!['attendance', 'earned'].includes(creditMode)) throw new Error('Choose a paid credit rule.');
  if (calculationMode === 'hourly_workings' && draft.divisor_mode === 'working') throw new Error('Hourly workings requires a calendar or fixed-day salary divisor.');
  if (!['calendar', 'fixed', 'working'].includes(draft.divisor_mode)) throw new Error('Choose a salary divisor.');
  const fixedDays = nonnegativeDecimal(draft.fixed_days, 'Fixed days', { max: 31 });
  const hours = nonnegativeDecimal(draft.hours_per_day, 'Hours per day', { max: 24 });
  const multiplier = nonnegativeDecimal(draft.ot_multiplier, 'OT multiplier', { max: 10 });
  if (fixedDays < 1) throw new Error('Fixed days must be between 1 and 31.');
  if (hours <= 0) throw new Error('Hours per day must be greater than zero.');
  return { calculation_mode: calculationMode, credit_mode: creditMode, divisor_mode: draft.divisor_mode, fixed_days: fixedDays, hours_per_day: hours,
    ot_multiplier: multiplier, deduct_late: Boolean(draft.deduct_late), notes: String(draft.notes ?? '').trim() };
}

export function isCompletePayrollRegister(row) {
  if (!row || typeof row !== 'object') return false;
  if (Number(row.schema_version) >= 3 && ['bonus', 'adjustment_incentive', 'adjustment_deductions', 'ledger_advance_recovery'].some(key =>
    !['number', 'string'].includes(typeof row[key]) || String(row[key]).trim() === '' || !Number.isFinite(Number(row[key])) || Number(row[key]) < 0)) return false;
  if (Number(row.schema_version) >= 4) {
    if (!['paid_days', 'hourly_workings'].includes(row.calculation_mode) || !['recorded', 'reviewed'].includes(row.attendance_source)
      || !['attendance', 'earned'].includes(row.credit_mode) || typeof row.attendance_reviewed !== 'boolean') return false;
    if (!['tds', 'worked_minutes', 'worked_hours', ...HOURLY_REGISTER_COLUMNS.filter(column => column.type !== 'text').map(column => column.key)].every(key =>
      ['number', 'string'].includes(typeof row[key]) && String(row[key]).trim() !== '' && Number.isFinite(Number(row[key]))
      && (key === 'net_roundoff' || Number(row[key]) >= 0))) return false;
    if (row.attendance_source === 'reviewed' ? typeof row.attendance_review_reason !== 'string' || !row.attendance_review_reason.trim()
      : row.attendance_review_reason != null && typeof row.attendance_review_reason !== 'string') return false;
  }
  return PAYROLL_REGISTER_COLUMNS.every(({ key, type }) => {
    if (!Object.hasOwn(row, key)) return false;
    if (type === 'text') return typeof row[key] === 'string';
    if (row.variable_shift_hours === true && row.shift_basis === 'assigned_shift'
      && ['per_day_working_hour', 'per_hour_wages'].includes(key)) return row[key] === null;
    return (typeof row[key] === 'number' || (typeof row[key] === 'string' && row[key].trim() !== ''))
      && Number.isFinite(Number(row[key]));
  });
}

export function payrollRegisterRows(payslips) {
  const columns = payrollRegisterColumns(payslips);
  return payslips.map((payslip) => {
    if (!isCompletePayrollRegister(payslip.payroll_register)) {
      throw new Error('This run has missing or incomplete worksheet snapshots. Recalculate the draft before exporting.');
    }
    return columns.map(({ key, type }) => payslip.payroll_register.variable_shift_hours
      && ['per_day_working_hour', 'per_hour_wages'].includes(key) ? 'Varies by shift' : type === 'text'
        ? payslip.payroll_register[key] ?? '' : Number(payslip.payroll_register[key] ?? 0));
  });
}

export function buildPayrollWorkbook(XLSX, payslips) {
  const rows = payrollRegisterRows(payslips);
  const columns = payrollRegisterColumns(payslips);
  const worksheet = XLSX.utils.aoa_to_sheet([columns.map(({ label }) => label), ...rows]);
  // Explicit text cells preserve employee names beginning with =, +, - or @ as literal text.
  // AOA also preserves the user's two distinct columns with identical Salary headers.
  for (let row = 0; row <= rows.length; row += 1) {
    columns.forEach(({ type }, column) => {
      const cell = worksheet[XLSX.utils.encode_cell({ r: row, c: column })];
      if (row === 0 || type === 'text' || cell.t === 's') {
        cell.t = 's';
        delete cell.f;
      } else cell.z = type === 'money' ? '#,##0.00' : '0.##';
    });
  }
  worksheet['!cols'] = columns.map(({ key, type }) => ({ wch: key === 'employee_name' ? 28 : type === 'text' ? 20 : 19 }));
  worksheet['!autofilter'] = { ref: worksheet['!ref'] };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Payroll register');
  const shiftRows = payslips.flatMap(({ payroll_register: register }) => (register.shift_days ?? []).map(day => [
    register.employee_code || '', register.employee_name, day.work_date, day.shift_name,
    day.daily_hours ?? day.daily_minutes / 60, day.hourly_rate ?? register.per_hour_wages,
    register.attendance_source === 'reviewed' ? 'HR-reviewed monthly total' : day.worked_hours ?? day.worked_minutes / 60,
  ]));
  if (shiftRows.length) {
    const shiftSheet = XLSX.utils.aoa_to_sheet([['Employee code', 'Employee', 'Date', 'Shift', 'Daily hours', 'Hour rate', 'Worked hours'], ...shiftRows]);
    shiftSheet['!cols'] = [{ wch: 18 }, { wch: 28 }, { wch: 14 }, { wch: 24 }, { wch: 16 }, { wch: 16 }, { wch: 26 }];
    shiftSheet['!autofilter'] = { ref: shiftSheet['!ref'] };
    XLSX.utils.book_append_sheet(workbook, shiftSheet, 'Shift basis by date');
  }
  return workbook;
}

export async function exportPayrollRegister(payslips, company, period) {
  const XLSX = await import('xlsx');
  const workbook = buildPayrollWorkbook(XLSX, payslips);
  const safeCompany = String(company || 'company').replace(/[^a-zA-Z0-9_-]+/g, '-');
  XLSX.writeFile(workbook, `Payroll-${safeCompany}-${period}.xlsx`);
}
