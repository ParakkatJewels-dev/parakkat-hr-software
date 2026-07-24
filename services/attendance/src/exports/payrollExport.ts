// Payroll export: one row per employee for a chosen month, with a configurable column layout.
import ExcelJS from 'exceljs';
import { prisma } from '../lib/db';
import { logger } from '../lib/logger';
import { monthBounds, minutesToHours } from '../lib/time';
import { resolveColumns } from './columns';

export interface PayrollRow {
  employeeId: string;
  employeeCode: string | null;
  empCode: string | null;
  fullName: string;
  entityName: string | null;
  branchName: string | null;
  departmentName: string | null;
  designationName: string | null;

  calendarDays: number;
  daysPresent: number;
  daysAbsent: number;
  weeklyOffs: number;
  holidays: number;
  paidLeaveDays: number;
  lopDays: number;
  payableDays: number;
  otHours: number;
  workedHours: number;
  lateCount: number;
  lateMinutes: number;
  earlyExitCount: number;
  missingPunches: number;
  halfDays: number;
}

export interface PayrollQuery {
  year: number;
  month: number;
  /** Restrict to these branches; null = every branch the caller may see. */
  branchIds?: string[] | null;
  entityIds?: string[] | null;
  columns?: string[];
}

export async function buildPayrollRows(query: PayrollQuery): Promise<PayrollRow[]> {
  const { from, to } = monthBounds(query.year, query.month);

  // Prisma throws on an `undefined` parameter, and an empty array would filter everything out
  // rather than meaning "no filter". Normalise both to null, which the SQL reads as "all".
  const branchIds = query.branchIds?.length ? query.branchIds : null;
  const entityIds = query.entityIds?.length ? query.entityIds : null;

  const rows = await prisma.$queryRaw<
    Array<{
      employee_id: string;
      employee_code: string | null;
      emp_code: string | null;
      full_name: string;
      entity_name: string | null;
      branch_name: string | null;
      department_name: string | null;
      designation_name: string | null;
      calendar_days: bigint;
      days_present: number;
      days_absent: number;
      weekly_offs: number;
      holidays: number;
      paid_leave_days: number;
      lop_days: number;
      payable_days: number;
      ot_minutes: number;
      worked_minutes: number;
      late_count: number;
      late_minutes: number;
      early_exit_count: number;
      missing_punches: number;
      half_days: number;
    }>
  >`
    select
      e.id                       as employee_id,
      e.employee_code,
      be.emp_code,
      e.full_name,
      ent.name                   as entity_name,
      br.name                    as branch_name,
      dep.name                   as department_name,
      des.title                  as designation_name,
      count(a.id)                                                            as calendar_days,
      coalesce(sum(case when a.status in ('Present','Half Day')
                        then a.day_fraction else 0 end), 0)::float8          as days_present,
      coalesce(sum(case when a.status = 'Absent' then 1 else 0 end), 0)::float8 as days_absent,
      coalesce(sum(case when a.status = 'Weekly Off' then 1 else 0 end), 0)::float8 as weekly_offs,
      coalesce(sum(case when a.status = 'Holiday' then 1 else 0 end), 0)::float8   as holidays,
      coalesce(sum(case when a.status = 'On Leave' and not a.is_lop
                        then a.day_fraction else 0 end), 0)::float8          as paid_leave_days,
      coalesce(sum(case when a.is_lop then 1 else 0 end), 0)::float8         as lop_days,
      coalesce(sum(a.day_fraction), 0)::float8                               as payable_days,
      coalesce(sum(a.ot_minutes), 0)::float8                                 as ot_minutes,
      coalesce(sum(a.worked_minutes), 0)::float8                             as worked_minutes,
      coalesce(sum(case when a.is_late then 1 else 0 end), 0)::float8        as late_count,
      coalesce(sum(a.late_minutes), 0)::float8                               as late_minutes,
      coalesce(sum(case when a.is_early_exit then 1 else 0 end), 0)::float8  as early_exit_count,
      coalesce(sum(case when a.is_missing_punch then 1 else 0 end), 0)::float8 as missing_punches,
      coalesce(sum(case when a.status = 'Half Day' then 1 else 0 end), 0)::float8 as half_days
    from public.employees e
    left join public.attendance a
           on a.employee_id = e.id and a.work_date between ${from}::date and ${to}::date
    left join public.biotime_employees be on be.employee_id = e.id
    left join public.entities     ent on ent.id = e.entity_id
    left join public.branches     br  on br.id  = e.branch_id
    left join public.departments  dep on dep.id = e.department_id
    left join public.designations des on des.id = e.designation_id
    where e.status = 'Active'
      and (${branchIds}::uuid[] is null or e.branch_id = any(${branchIds}::uuid[]))
      and (${entityIds}::uuid[] is null or e.entity_id = any(${entityIds}::uuid[]))
    group by e.id, e.employee_code, be.emp_code, e.full_name,
             ent.name, br.name, dep.name, des.title
    order by br.name nulls last, e.full_name
  `;

  return rows.map((r) => ({
    employeeId: r.employee_id,
    employeeCode: r.employee_code,
    empCode: r.emp_code,
    fullName: r.full_name,
    entityName: r.entity_name,
    branchName: r.branch_name,
    departmentName: r.department_name,
    designationName: r.designation_name,
    calendarDays: Number(r.calendar_days),
    daysPresent: Number(r.days_present),
    daysAbsent: Number(r.days_absent),
    weeklyOffs: Number(r.weekly_offs),
    holidays: Number(r.holidays),
    paidLeaveDays: Number(r.paid_leave_days),
    lopDays: Number(r.lop_days),
    payableDays: Number(r.payable_days),
    otHours: minutesToHours(Number(r.ot_minutes)),
    workedHours: minutesToHours(Number(r.worked_minutes)),
    lateCount: Number(r.late_count),
    lateMinutes: Number(r.late_minutes),
    earlyExitCount: Number(r.early_exit_count),
    missingPunches: Number(r.missing_punches),
    halfDays: Number(r.half_days),
  }));
}

export async function buildPayrollWorkbook(query: PayrollQuery): Promise<ExcelJS.Workbook> {
  const columns = resolveColumns(query.columns);
  const rows = await buildPayrollRows(query);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Parakkat HRMS';
  workbook.created = new Date();

  const monthLabel = `${query.year}-${String(query.month).padStart(2, '0')}`;
  const sheet = workbook.addWorksheet(`Payroll ${monthLabel}`, {
    views: [{ state: 'frozen', ySplit: 3, xSplit: 1 }],
  });

  // Title block — payroll files get emailed around, so they must say what they are.
  sheet.mergeCells(1, 1, 1, Math.max(columns.length, 2));
  const title = sheet.getCell(1, 1);
  title.value = `Payroll Attendance Summary — ${monthLabel}`;
  title.font = { bold: true, size: 14 };
  title.alignment = { horizontal: 'left' };

  sheet.mergeCells(2, 1, 2, Math.max(columns.length, 2));
  const subtitle = sheet.getCell(2, 1);
  subtitle.value = `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · ${rows.length} employees`;
  subtitle.font = { size: 9, color: { argb: 'FF6B7280' } };

  const headerRow = sheet.getRow(3);
  columns.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.header;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0EA971' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF0B8659' } } };
    sheet.getColumn(i + 1).width = col.width;
  });
  headerRow.height = 26;

  rows.forEach((row, rowIndex) => {
    const excelRow = sheet.getRow(rowIndex + 4);
    columns.forEach((col, colIndex) => {
      const cell = excelRow.getCell(colIndex + 1);
      cell.value = col.value(row);
      if (col.type === 'number') {
        cell.numFmt = col.numFmt ?? '0';
        cell.alignment = { horizontal: 'right' };
      }
      if (rowIndex % 2 === 1) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7FAF9' } };
      }
    });
  });

  // Totals for the numeric columns — the first thing anyone checking a payroll file looks for.
  const totalRow = sheet.getRow(rows.length + 4);
  columns.forEach((col, i) => {
    const cell = totalRow.getCell(i + 1);
    if (i === 0) {
      cell.value = 'TOTAL';
    } else if (col.type === 'number' && col.key !== 'calendar_days') {
      const sum = rows.reduce((acc, r) => acc + Number(col.value(r) ?? 0), 0);
      cell.value = Math.round(sum * 100) / 100;
      cell.numFmt = col.numFmt ?? '0';
      cell.alignment = { horizontal: 'right' };
    }
    cell.font = { bold: true };
    cell.border = { top: { style: 'double', color: { argb: 'FF0EA971' } } };
  });

  sheet.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: columns.length } };

  logger.info({ month: monthLabel, employees: rows.length, columns: columns.length }, 'payroll export built');
  return workbook;
}
