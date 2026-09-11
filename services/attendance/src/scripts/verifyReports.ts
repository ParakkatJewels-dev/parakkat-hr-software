// Runs only against a cluster this script creates. No .env database or running worker is used.
// Requires PostgreSQL's initdb and pg_ctl on PATH; npm run test:reports.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

async function main() {
  const directory = mkdtempSync('/tmp/hr-attendance-report-');
  const dataDirectory = join(directory, 'data');
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  let started = false;
  let client: PrismaClient | undefined;
  let disconnectService: (() => Promise<void>) | undefined;
  try {
    execFileSync('initdb', ['-D', dataDirectory, '-A', 'trust', '-U', 'attendance_fixture', '--no-locale', '--encoding=UTF8'], { stdio: 'pipe' });
    execFileSync('pg_ctl', ['-D', dataDirectory, '-l', join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${directory}`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    const databaseUrl = `postgresql://attendance_fixture@127.0.0.1:${port}/postgres`;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = 'test';
    process.env.LOG_LEVEL = 'error';
    process.env.ENABLE_WORKERS = 'false';
    client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

    const schema = [
      'create table entities (id uuid primary key, name text)',
      'create table branches (id uuid primary key, name text, entity_id uuid, zone_id uuid)',
      'create table departments (id uuid primary key, name text)',
      'create table designations (id uuid primary key, title text)',
      'create table employees (id uuid primary key, employee_code text, full_name text, entity_id uuid, branch_id uuid, department_id uuid, designation_id uuid, status text)',
      'create table biotime_employees (emp_code text primary key, employee_id uuid)',
      'create table leaves (id uuid primary key, day_fraction numeric)',
      `create table attendance (id bigint generated always as identity primary key, employee_id uuid, work_date date, status text, day_fraction numeric,
        is_lop boolean default false, leave_id uuid, ot_minutes int default 0, worked_minutes int default 0,
        is_late boolean default false, late_minutes int default 0, is_early_exit boolean default false, is_missing_punch boolean default false)`,
    ];
    for (const statement of schema) await client.$executeRawUnsafe(statement);
    await client.$executeRaw`insert into entities values (${id(1001)}::uuid, 'Fixture Company')`;
    await client.$executeRaw`insert into branches values (${id(1002)}::uuid, 'A Branch', ${id(1001)}::uuid, null), (${id(1003)}::uuid, 'B Branch', ${id(1001)}::uuid, null)`;
    await client.$executeRaw`
      insert into employees (id, employee_code, full_name, entity_id, branch_id, status)
      select ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
             'E' || lpad(i::text, 4, '0'), 'Employee ' || lpad(i::text, 4, '0'),
             ${id(1001)}::uuid, case when i <= 500 then ${id(1002)}::uuid else ${id(1003)}::uuid end,
             case when i = 503 then 'Inactive' else 'Active' end
      from generate_series(1, 503) i`;
    await client.$executeRaw`
      insert into attendance (employee_id, work_date, status, day_fraction, ot_minutes, worked_minutes)
      select id, ('2026-07-01'::date + (d - 1)), 'Present', 1, 1, 510
      from employees cross join generate_series(1, 3) d where employee_code <> 'E0502'`;
    await client.$executeRaw`insert into biotime_employees values ('101', ${id(1)}::uuid), ('201', ${id(1)}::uuid)`;
    await client.$executeRaw`insert into leaves values (${id(2001)}::uuid, 1), (${id(2002)}::uuid, 0.5), (${id(2003)}::uuid, 0.5)`;
    await client.$executeRaw`
      insert into attendance (employee_id, work_date, status, day_fraction, worked_minutes, leave_id, is_lop, is_missing_punch) values
      (${id(1)}::uuid, '2026-07-04', 'Half Day', 0.5, 255, null, false, false),
      (${id(1)}::uuid, '2026-07-05', 'Missing Punch', 0.5, 255, null, false, true),
      (${id(1)}::uuid, '2026-07-06', 'On Leave', 1, 0, ${id(2001)}::uuid, false, false),
      (${id(1)}::uuid, '2026-07-07', 'On Leave', 1, 255, ${id(2002)}::uuid, false, false),
      (${id(1)}::uuid, '2026-07-08', 'Half Day', 0.5, 255, ${id(2003)}::uuid, true, false),
      (${id(1)}::uuid, '2026-07-09', 'Absent', 0, 0, null, false, false)`;

    // Internal modules are loaded only after their URL has been forced to this disposable cluster.
    const { buildPayrollRows, buildPayrollWorkbook } = require('../exports/payrollExport') as typeof import('../exports/payrollExport');
    const { buildRegisterRows, buildRegisterWorkbook } = require('../exports/registerReport') as typeof import('../exports/registerReport');
    const { scopeFor } = require('../exports/generate') as typeof import('../exports/generate');
    disconnectService = (require('../lib/db') as typeof import('../lib/db')).disconnectDb;
    const period = { year: 2026, month: 7 };
    const payroll = await buildPayrollRows(period);
    const register = await buildRegisterRows(period);
    assert.equal(payroll.length, 503, 'one payroll row per person, including an inactive employee with attendance');
    assert.equal(new Set(payroll.map((row) => row.employeeId)).size, 503, 'multiple enrolments must not duplicate payroll');
    assert.equal(register.rows.length, 503);
    const first = payroll.find((row) => row.employeeId === id(1))!;
    assert.equal(first.empCode, '101, 201');
    assert.deepEqual({ present: first.daysPresent, leave: first.paidLeaveDays, lop: first.lopDays, payable: first.payableDays, ot: first.otHours, hours: first.workedHours },
      { present: 5, leave: 1.5, lop: 0.5, payable: 6.5, ot: 0.05, hours: 42.5 });
    const firstRegister = register.rows.find((row) => row.employeeId === id(1))!;
    assert.deepEqual({ present: firstRegister.totals.present, leave: firstRegister.totals.leave, lop: firstRegister.totals.lop, payable: firstRegister.totals.payable, ot: firstRegister.totals.otHours },
      { present: 5, leave: 1.5, lop: 0.5, payable: 6.5, ot: 0.05 });
    assert.equal(payroll.find((row) => row.employeeId === id(502))!.payableDays, 0);
    assert.equal(register.dates.length, 31);
    assert.equal(firstRegister.days.get('2026-07-04')?.dayFraction, 0.5);
    assert.equal((await buildPayrollRows({ ...period, branchIds: [] })).length, 0, 'explicit empty scope cannot become every branch');
    assert.equal((await buildRegisterRows({ ...period, entityIds: [] })).rows.length, 0);
    assert.equal((await buildPayrollRows({ ...period, branchIds: [id(1002)] })).length, 500);
    const branchAuth = { userId: 'fixture', email: null, isSuperAdmin: false, permissions: [{ permission: 'report.read', scope_type: 'branch', scope_id: id(1002) }], employee: null };
    const branchScope = await scopeFor(branchAuth, ['report.read']);
    assert.deepEqual(branchScope, { branchIds: [id(1002)], entityIds: null });
    await assert.rejects(() => scopeFor(branchAuth, ['report.read'], id(1003)), { status: 403 });
    await assert.rejects(() => scopeFor({ ...branchAuth, permissions: [] }, ['report.read']), { status: 403 });

    // 503 employees x 31 days, independently checked after actual XLSX serialization and reload.
    await client.$executeRaw`
      insert into attendance (employee_id, work_date, status, day_fraction, worked_minutes)
      select id, '2026-07-01'::date + (d - 1), 'Present', 1, 510
      from employees cross join generate_series(10, 31) d`;
    const startedAt = performance.now();
    const registerWorkbook = await buildRegisterWorkbook(period);
    const registerBytes = await registerWorkbook.xlsx.writeBuffer();
    const reloadedRegister = new ExcelJS.Workbook();
    await reloadedRegister.xlsx.load(registerBytes);
    const sheet = reloadedRegister.getWorksheet('Register')!;
    assert.equal(sheet.rowCount, 507);
    assert.equal(sheet.getCell('B5').value, 'Employee 0001');
    assert.equal(sheet.getRow(5).getCell(34).value, 'P', 'the final day of month survives serialization');
    assert.equal(sheet.getRow(5).getCell(40).value, 28.5, 'payable total includes the entire month');
    const numericWorkbook = await buildPayrollWorkbook({ ...period, columns: ['payable_days', 'full_name', 'ot_hours'] });
    const numericBytes = await numericWorkbook.xlsx.writeBuffer();
    const reloadedPayroll = new ExcelJS.Workbook();
    await reloadedPayroll.xlsx.load(numericBytes);
    const payrollSheet = reloadedPayroll.worksheets[0]!;
    assert.equal(payrollSheet.getRow(507).getCell(1).value, 12575.5, 'a numeric first column retains its total');
    assert.equal(payrollSheet.getRow(507).getCell(2).value, 'TOTAL');
    console.log(JSON.stringify({ ok: true, employees: 503, populatedDays: 25, registerBytes: registerBytes.byteLength, payrollBytes: numericBytes.byteLength, workbookRoundtripMs: Math.round(performance.now() - startedAt), checks: 'SQL totals, multi-device employees, historical inactive employees, scope denials, XLSX serialization and totals' }, null, 2));
  } finally {
    await disconnectService?.();
    await client?.$disconnect();
    if (started) execFileSync('pg_ctl', ['-D', dataDirectory, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
