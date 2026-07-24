// Monthly attendance register: one row per employee, one column per day, plus totals.
// This is the sheet HR prints and pins up, so it is optimised for reading at a glance.
import ExcelJS from 'exceljs';
import { prisma } from '../lib/db';
import { logger } from '../lib/logger';
import { monthBounds, eachWorkDate, minutesToHours, DateTime, APP_TZ } from '../lib/time';

/** Single-letter codes keep 31 day-columns readable on one page. */
export const STATUS_CODES: Record<string, { code: string; fill: string; label: string }> = {
  Present: { code: 'P', fill: 'FFD1FAE5', label: 'Present' },
  'Half Day': { code: 'H', fill: 'FFFEF3C7', label: 'Half day' },
  Absent: { code: 'A', fill: 'FFFEE2E2', label: 'Absent' },
  'Weekly Off': { code: 'W', fill: 'FFF3F4F6', label: 'Weekly off' },
  Holiday: { code: 'F', fill: 'FFDBEAFE', label: 'Holiday (festival)' },
  'On Leave': { code: 'L', fill: 'FFE0E7FF', label: 'On leave' },
  'Missing Punch': { code: 'M', fill: 'FFFFEDD5', label: 'Missing punch' },
  'No Shift': { code: '?', fill: 'FFF5F3FF', label: 'No shift assigned' },
};

const LOP_CODE = { code: 'LP', fill: 'FFFECACA', label: 'Loss of pay' };

export interface RegisterQuery {
  year: number;
  month: number;
  branchIds?: string[] | null;
  entityIds?: string[] | null;
}

interface RegisterCell {
  status: string;
  isLop: boolean;
  isLate: boolean;
  dayFraction: number;
}

export interface RegisterRow {
  employeeId: string;
  employeeCode: string | null;
  fullName: string;
  branchName: string | null;
  departmentName: string | null;
  days: Map<string, RegisterCell>;
  totals: {
    present: number;
    absent: number;
    leave: number;
    lop: number;
    weeklyOff: number;
    holiday: number;
    payable: number;
    otHours: number;
    lateCount: number;
  };
}

export async function buildRegisterRows(query: RegisterQuery): Promise<{ rows: RegisterRow[]; dates: string[] }> {
  const { from, to } = monthBounds(query.year, query.month);
  const dates = eachWorkDate(from, to);

  // Prisma throws on `undefined`; an empty array would exclude everyone rather than mean
  // "no filter". Both normalise to null, which the SQL reads as "all".
  const branchIds = query.branchIds?.length ? query.branchIds : null;
  const entityIds = query.entityIds?.length ? query.entityIds : null;

  const records = await prisma.$queryRaw<
    Array<{
      employee_id: string;
      employee_code: string | null;
      full_name: string;
      branch_name: string | null;
      department_name: string | null;
      work_date: Date | null;
      status: string | null;
      is_lop: boolean | null;
      is_late: boolean | null;
      day_fraction: number | null;
      ot_minutes: number | null;
    }>
  >`
    select e.id                as employee_id,
           e.employee_code,
           e.full_name,
           br.name             as branch_name,
           dep.name            as department_name,
           a.work_date,
           a.status,
           a.is_lop,
           a.is_late,
           a.day_fraction::float8 as day_fraction,
           a.ot_minutes
      from public.employees e
      left join public.attendance a
             on a.employee_id = e.id and a.work_date between ${from}::date and ${to}::date
      left join public.branches    br  on br.id  = e.branch_id
      left join public.departments dep on dep.id = e.department_id
     where e.status = 'Active'
       and (${branchIds}::uuid[] is null or e.branch_id = any(${branchIds}::uuid[]))
       and (${entityIds}::uuid[] is null or e.entity_id = any(${entityIds}::uuid[]))
     order by br.name nulls last, e.full_name, a.work_date
  `;

  const byEmployee = new Map<string, RegisterRow>();

  for (const r of records) {
    let row = byEmployee.get(r.employee_id);
    if (!row) {
      row = {
        employeeId: r.employee_id,
        employeeCode: r.employee_code,
        fullName: r.full_name,
        branchName: r.branch_name,
        departmentName: r.department_name,
        days: new Map(),
        totals: {
          present: 0, absent: 0, leave: 0, lop: 0,
          weeklyOff: 0, holiday: 0, payable: 0, otHours: 0, lateCount: 0,
        },
      };
      byEmployee.set(r.employee_id, row);
    }

    if (!r.work_date || !r.status) continue;

    const key = DateTime.fromJSDate(r.work_date, { zone: 'utc' }).setZone(APP_TZ).toFormat('yyyy-MM-dd');
    const fraction = Number(r.day_fraction ?? 0);

    row.days.set(key, {
      status: r.status,
      isLop: Boolean(r.is_lop),
      isLate: Boolean(r.is_late),
      dayFraction: fraction,
    });

    row.totals.payable += fraction;
    row.totals.otHours += minutesToHours(Number(r.ot_minutes ?? 0));
    if (r.is_late) row.totals.lateCount += 1;

    switch (r.status) {
      case 'Present':
      case 'Half Day':
      case 'Missing Punch':
        row.totals.present += fraction;
        break;
      case 'Absent':
        row.totals.absent += 1;
        break;
      case 'On Leave':
        if (r.is_lop) row.totals.lop += 1;
        else row.totals.leave += fraction;
        break;
      case 'Weekly Off':
        row.totals.weeklyOff += 1;
        break;
      case 'Holiday':
        row.totals.holiday += 1;
        break;
    }
  }

  const rows = [...byEmployee.values()].map((r) => ({
    ...r,
    totals: { ...r.totals, otHours: Math.round(r.totals.otHours * 100) / 100 },
  }));

  return { rows, dates };
}

export async function buildRegisterWorkbook(query: RegisterQuery): Promise<ExcelJS.Workbook> {
  const { rows, dates } = await buildRegisterRows(query);
  const monthLabel = DateTime.fromObject({ year: query.year, month: query.month }, { zone: APP_TZ }).toFormat('LLLL yyyy');

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Parakkat HRMS';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Register', {
    views: [{ state: 'frozen', xSplit: 3, ySplit: 4 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  const FIXED = 3;            // code, name, branch
  const TOTALS = 7;
  const totalCols = FIXED + dates.length + TOTALS;

  sheet.mergeCells(1, 1, 1, totalCols);
  const title = sheet.getCell(1, 1);
  title.value = `Monthly Attendance Register — ${monthLabel}`;
  title.font = { bold: true, size: 14 };

  sheet.mergeCells(2, 1, 2, totalCols);
  const legend = sheet.getCell(2, 1);
  legend.value =
    'P Present · H Half day · A Absent · L Leave · LP Loss of pay · W Weekly off · F Holiday · M Missing punch · ? No shift';
  legend.font = { size: 9, color: { argb: 'FF6B7280' } };

  // Row 3: day-of-week initials. Row 4: the headers proper.
  const dowRow = sheet.getRow(3);
  const headerRow = sheet.getRow(4);

  ['Code', 'Employee', 'Branch'].forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0EA971' } };
    cell.alignment = { vertical: 'middle' };
  });
  sheet.getColumn(1).width = 14;
  sheet.getColumn(2).width = 26;
  sheet.getColumn(3).width = 18;

  dates.forEach((date, i) => {
    const col = FIXED + i + 1;
    const dt = DateTime.fromISO(date, { zone: APP_TZ });
    const isSunday = dt.weekday === 7;

    const dowCell = dowRow.getCell(col);
    dowCell.value = dt.toFormat('ccccc');            // single letter
    dowCell.font = { size: 8, color: { argb: isSunday ? 'FFDC2626' : 'FF9CA3AF' } };
    dowCell.alignment = { horizontal: 'center' };

    const cell = headerRow.getCell(col);
    cell.value = dt.day;
    cell.font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: isSunday ? 'FF0B8659' : 'FF0EA971' },
    };
    cell.alignment = { horizontal: 'center' };
    sheet.getColumn(col).width = 4.2;
  });

  const totalHeaders = ['Present', 'Absent', 'Leave', 'LOP', 'W/Off', 'Payable', 'OT Hrs'];
  totalHeaders.forEach((h, i) => {
    const col = FIXED + dates.length + i + 1;
    const cell = headerRow.getCell(col);
    cell.value = h;
    cell.font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF374151' } };
    cell.alignment = { horizontal: 'center', wrapText: true };
    sheet.getColumn(col).width = 9;
  });
  headerRow.height = 22;

  rows.forEach((row, rowIndex) => {
    const excelRow = sheet.getRow(rowIndex + 5);

    excelRow.getCell(1).value = row.employeeCode ?? '';
    excelRow.getCell(2).value = row.fullName;
    excelRow.getCell(3).value = row.branchName ?? '';

    dates.forEach((date, i) => {
      const cell = excelRow.getCell(FIXED + i + 1);
      const day = row.days.get(date);

      if (!day) {
        cell.value = '';
        return;
      }

      const mapping = day.isLop ? LOP_CODE : STATUS_CODES[day.status] ?? { code: '·', fill: 'FFFFFFFF' };
      cell.value = mapping.code;
      cell.alignment = { horizontal: 'center' };
      cell.font = { size: 9, bold: day.status === 'Absent' || day.isLop };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: mapping.fill } };

      // A red bottom border flags lateness without spending a whole column on it.
      if (day.isLate) {
        cell.border = { bottom: { style: 'medium', color: { argb: 'FFDC2626' } } };
      }
    });

    const totals = [
      row.totals.present,
      row.totals.absent,
      row.totals.leave,
      row.totals.lop,
      row.totals.weeklyOff,
      row.totals.payable,
      row.totals.otHours,
    ];

    totals.forEach((value, i) => {
      const cell = excelRow.getCell(FIXED + dates.length + i + 1);
      cell.value = Math.round(value * 100) / 100;
      cell.numFmt = '0.##';
      cell.alignment = { horizontal: 'center' };
      cell.font = { size: 9, bold: true };
    });
  });

  sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: 3 } };

  logger.info({ month: monthLabel, employees: rows.length, days: dates.length }, 'register report built');
  return workbook;
}
