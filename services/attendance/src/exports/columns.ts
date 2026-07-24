// The payroll export column catalog.
//
// Payroll formats are specific to whoever processes them, and "make it match my format" is a
// recurring request rather than a one-off. So the export is assembled from a named catalog: the
// caller sends a list of column keys in the order they want, and the file comes out that shape.
// Adding a new derived column means adding one entry here, not editing the export routine.
import type { PayrollRow } from './payrollExport';

export interface ColumnDef {
  key: string;
  header: string;
  width: number;
  /** 'text' | 'number' | 'date' — drives cell formatting in the workbook. */
  type: 'text' | 'number' | 'date';
  numFmt?: string;
  value: (row: PayrollRow) => string | number | Date | null;
  description: string;
}

export const PAYROLL_COLUMNS: ColumnDef[] = [
  {
    key: 'employee_code',
    header: 'Employee Code',
    width: 16,
    type: 'text',
    value: (r) => r.employeeCode ?? '',
    description: 'HR employee code',
  },
  {
    key: 'emp_code',
    header: 'Device Code',
    width: 13,
    type: 'text',
    value: (r) => r.empCode ?? '',
    description: 'BioTime enrolment number',
  },
  {
    key: 'full_name',
    header: 'Employee Name',
    width: 28,
    type: 'text',
    value: (r) => r.fullName,
    description: 'Full name',
  },
  {
    key: 'entity',
    header: 'Company',
    width: 22,
    type: 'text',
    value: (r) => r.entityName ?? '',
    description: 'Legal entity',
  },
  {
    key: 'branch',
    header: 'Branch',
    width: 20,
    type: 'text',
    value: (r) => r.branchName ?? '',
    description: 'Branch / location',
  },
  {
    key: 'department',
    header: 'Department',
    width: 20,
    type: 'text',
    value: (r) => r.departmentName ?? '',
    description: 'Department',
  },
  {
    key: 'designation',
    header: 'Designation',
    width: 22,
    type: 'text',
    value: (r) => r.designationName ?? '',
    description: 'Job title',
  },
  {
    key: 'calendar_days',
    header: 'Calendar Days',
    width: 13,
    type: 'number',
    value: (r) => r.calendarDays,
    description: 'Days in the month',
  },
  {
    key: 'days_present',
    header: 'Days Present',
    width: 13,
    type: 'number',
    numFmt: '0.0',
    value: (r) => r.daysPresent,
    description: 'Full + half days actually worked',
  },
  {
    key: 'days_absent',
    header: 'Days Absent',
    width: 13,
    type: 'number',
    numFmt: '0.0',
    value: (r) => r.daysAbsent,
    description: 'Unexplained absences',
  },
  {
    key: 'weekly_offs',
    header: 'Weekly Offs',
    width: 12,
    type: 'number',
    value: (r) => r.weeklyOffs,
    description: 'Rostered days off',
  },
  {
    key: 'holidays',
    header: 'Holidays',
    width: 11,
    type: 'number',
    value: (r) => r.holidays,
    description: 'Company holidays',
  },
  {
    key: 'paid_leave',
    header: 'Paid Leave',
    width: 12,
    type: 'number',
    numFmt: '0.0',
    value: (r) => r.paidLeaveDays,
    description: 'Approved leave drawn from a balance',
  },
  {
    key: 'lop_days',
    header: 'LOP Days',
    width: 11,
    type: 'number',
    numFmt: '0.0',
    value: (r) => r.lopDays,
    description: 'Loss of pay days',
  },
  {
    key: 'payable_days',
    header: 'Payable Days',
    width: 13,
    type: 'number',
    numFmt: '0.0',
    value: (r) => r.payableDays,
    description: 'Sum of day_fraction — the number payroll multiplies by',
  },
  {
    key: 'ot_hours',
    header: 'OT Hours',
    width: 11,
    type: 'number',
    numFmt: '0.00',
    value: (r) => r.otHours,
    description: 'Overtime hours',
  },
  {
    key: 'worked_hours',
    header: 'Worked Hours',
    width: 13,
    type: 'number',
    numFmt: '0.00',
    value: (r) => r.workedHours,
    description: 'Total hours on the clock',
  },
  {
    key: 'late_count',
    header: 'Late Marks',
    width: 12,
    type: 'number',
    value: (r) => r.lateCount,
    description: 'Days arriving after grace',
  },
  {
    key: 'late_minutes',
    header: 'Late Minutes',
    width: 13,
    type: 'number',
    value: (r) => r.lateMinutes,
    description: 'Cumulative lateness',
  },
  {
    key: 'early_exit_count',
    header: 'Early Exits',
    width: 12,
    type: 'number',
    value: (r) => r.earlyExitCount,
    description: 'Days leaving before grace',
  },
  {
    key: 'missing_punches',
    header: 'Missing Punches',
    width: 15,
    type: 'number',
    value: (r) => r.missingPunches,
    description: 'Days with only one punch',
  },
  {
    key: 'half_days',
    header: 'Half Days',
    width: 11,
    type: 'number',
    value: (r) => r.halfDays,
    description: 'Days credited at 0.5',
  },
];

/** The layout used when the caller does not specify one. */
export const DEFAULT_PAYROLL_LAYOUT = [
  'employee_code',
  'full_name',
  'branch',
  'designation',
  'calendar_days',
  'days_present',
  'paid_leave',
  'lop_days',
  'weekly_offs',
  'holidays',
  'payable_days',
  'ot_hours',
];

export function resolveColumns(keys?: string[]): ColumnDef[] {
  const wanted = keys?.length ? keys : DEFAULT_PAYROLL_LAYOUT;
  const byKey = new Map(PAYROLL_COLUMNS.map((c) => [c.key, c]));

  const resolved: ColumnDef[] = [];
  const unknown: string[] = [];

  for (const key of wanted) {
    const col = byKey.get(key);
    if (col) resolved.push(col);
    else unknown.push(key);
  }

  if (unknown.length) {
    throw new Error(
      `Unknown payroll column(s): ${unknown.join(', ')}. ` +
        `Available: ${PAYROLL_COLUMNS.map((c) => c.key).join(', ')}`
    );
  }

  return resolved.length ? resolved : PAYROLL_COLUMNS.filter((c) => DEFAULT_PAYROLL_LAYOUT.includes(c.key));
}

/** Exposed at GET /api/exports/payroll/columns so the UI can offer a column picker. */
export function columnCatalog() {
  return PAYROLL_COLUMNS.map((c) => ({
    key: c.key,
    header: c.header,
    type: c.type,
    description: c.description,
    inDefault: DEFAULT_PAYROLL_LAYOUT.includes(c.key),
  }));
}
