// Wipe everything and rebuild it from Easy Time Pro, all of it.
//
//   npm run reset:from-device            show the plan, change nothing
//   npm run reset:from-device -- --apply
//   npm run reset:from-device -- --apply --from 2024-01-01   override the start date
//
// MUST RUN ON THE MACHINE THAT REACHES EASY TIME PRO. That is the whole reason this is one script
// rather than a sequence: it deletes first and refills from a source only this machine can see, so
// splitting the two would leave an empty system on any other computer.
//
// WHAT IT DELETES
//   every employee, punch, attendance row, enrolment link, payroll row, and the whole org
//   structure — four companies, 48 branches, zones, departments, designations.
//
// WHAT IT REBUILDS, FROM THE DEVICE ALONE
//   one company, named after the device's only area
//   its departments
//   one employee per enrolment
//   every transaction Easy Time Pro holds, from the first one it has to today
//   attendance derived from those punches
//
// WHAT EASY TIME PRO CANNOT GIVE BACK
//   PPL, PKT, HO90 and PJT are four separately registered companies; the device records one area
//   and has no company or branch field at all. Once this runs, that structure exists only in the
//   backup file written before the first delete. There is no way to rebuild it from the terminal.
//
// The whole rebuild runs in ONE transaction for the delete-and-recreate half. The punch download
// happens after it commits, because it takes minutes and holding a transaction open that long
// against a shared database would block everything else.
import fs from 'node:fs';
import path from 'node:path';
import { biotime } from '../biotime/client';
import { prisma } from '../lib/db';
import { logger } from '../lib/logger';
import { runTransactionSync } from '../sync/syncTransactions';
import { syncEmployees, refreshSuggestions } from '../sync/syncEmployees';
import { recompute } from '../engine/recompute';
import { todayWorkDate, DateTime, APP_TZ } from '../lib/time';
import { parseArgs, flag } from './args';
import { weeks } from './fetchAll';
import { earliestPunchDate } from '../sync/earliest';

const BACKUP_DIR = path.join(__dirname, '..', '..', 'backups');

async function main(): Promise<void> {
  const args = parseArgs();
  const apply = flag(args, 'apply');

  console.log(`\n  Rebuilding everything from ${biotime.baseUrl}\n`);

  const ping = await biotime.ping();
  if (!ping.ok) {
    console.log(`  Cannot reach Easy Time Pro: ${ping.error}`);
    console.log('  This must run on the machine where Easy Time Pro is installed.\n');
    process.exitCode = 1;
    return;
  }

  // --- what the device holds -------------------------------------------------------------------
  const areas = await prisma.$queryRaw<Array<{ area_name: string; n: bigint }>>`
    select area_name, count(*) as n from public.biotime_employees
     where area_name is not null group by area_name order by 2 desc
  `;
  const enrolments = await biotime.get<{ count?: number }>('/personnel/api/employees/', { page_size: 1 });
  const txnProbe = await biotime.get<{ count?: number }>('/iclock/api/transactions/', { page_size: 1 });

  const discovered = await earliestPunchDate();
  const to = todayWorkDate();
  const from = typeof args.from === 'string'
    ? args.from
    : discovered
      ?? DateTime.fromISO(to, { zone: APP_TZ }).minus({ years: 3 }).toFormat('yyyy-MM-dd');

  console.log('  EASY TIME PRO HOLDS');
  console.log(`    enrolments      ${enrolments?.count ?? '?'}`);
  console.log(`    transactions    ${txnProbe?.count ?? '?'}`);
  console.log(`    oldest punch    ${discovered ?? 'could not be read — using a 3-year window'}`);
  console.log(`    areas           ${areas.map((a) => `"${a.area_name}"`).join(', ') || '(none synced yet)'}`);

  const chunks = weeks(from, to);
  console.log(`\n  WOULD FETCH  ${from} .. ${to}   (${chunks.length} weekly requests)`);

  const before = await prisma.$queryRaw<Array<Record<string, bigint>>>`
    select (select count(*) from public.employees) employees,
           (select count(*) from public.raw_punches) punches,
           (select count(*) from public.attendance) attendance,
           (select count(*) from public.entities) entities,
           (select count(*) from public.branches) branches,
           (select count(*) from public.departments) departments,
           (select count(*) from public.designations) designations,
           (select count(*) from public.zones) zones,
           (select count(*) from public.payroll_runs) payroll_runs,
           (select count(*) from public.payslips) payslips
  `;
  const b = before[0]!;
  console.log('\n  WOULD DELETE');
  for (const [k, v] of Object.entries(b)) console.log(`    ${k.padEnd(16)} ${String(v)}`);

  console.log('\n  WOULD REBUILD, FROM THE DEVICE ONLY');
  console.log('    1 company (named after the area), its departments, one employee per enrolment,');
  console.log('    every transaction from the oldest to today, and attendance derived from them.');
  console.log('\n  GONE FOR GOOD — the device has no company or branch field, so nothing can');
  console.log('  rebuild these except the backup written before the first delete:');
  const ents = await prisma.$queryRaw<Array<{ code: string }>>`select code from public.entities order by code`;
  console.log(`    companies ${ents.map((e) => e.code).join(', ')}, 48 branches, ${b.designations} designations`);
  console.log(`    ${b.payroll_runs} payroll runs and ${b.payslips} payslips, one of them published`);

  if (!apply) {
    console.log('\n  Dry run — nothing changed. Re-run with --apply.\n');
    return;
  }

  // --- back up before the first delete ---------------------------------------------------------
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dump: Record<string, unknown> = { takenAt: new Date().toISOString() };
  for (const t of ['entities', 'zones', 'branches', 'departments', 'designations',
    'holiday_calendars', 'employees', 'payroll_runs', 'payslips', 'salary_structures']) {
    dump[t] = await prisma.$queryRawUnsafe(`select * from public.${t}`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(BACKUP_DIR, `full-reset-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(dump, null, 2));
  console.log(`\n  Backed up -> ${path.relative(process.cwd(), file)}`);

  // --- wipe and lay the new foundation, all or nothing ------------------------------------------
  const area = areas[0]?.area_name ?? 'Parakkat';
  const code = area.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'PARAKKAT';
  const name = area.trim().replace(/\b\w/g, (m) => m.toUpperCase());

  console.log('\n  [1/6] Clearing');
  await prisma.$transaction(async (tx) => {
    // Order follows the foreign keys: payroll and attendance hang off employees, everything
    // structural hangs off entities.
    await tx.$executeRawUnsafe('delete from public.attendance');
    await tx.$executeRawUnsafe('delete from public.attendance_recompute_queue');
    await tx.$executeRawUnsafe('delete from public.raw_punches');
    await tx.$executeRawUnsafe('delete from public.payslips');
    await tx.$executeRawUnsafe('delete from public.salary_structures');
    await tx.$executeRawUnsafe('delete from public.payroll_runs');
    await tx.$executeRawUnsafe('delete from public.biotime_employees');
    await tx.$executeRawUnsafe('delete from public.employees');
    await tx.$executeRawUnsafe('delete from public.entities');   // cascades the rest of the org

    // The cursor must forget where it got to, or the backfill below is skipped as "already seen".
    await tx.$executeRawUnsafe(
      `update public.sync_state set last_punch_time = null, last_transaction_id = null,
              last_success_at = null, consecutive_failures = 0, last_error = null`
    );

    await tx.$executeRawUnsafe(
      `insert into public.entities (code, name, is_active) values ($1, $2, true)`, code, name
    );
  }, { timeout: 120_000 });
  console.log(`        cleared; single company ${code} created`);

  // --- rebuild ----------------------------------------------------------------------------------
  console.log('\n  [2/6] Roster from the device');
  const roster = await syncEmployees();
  await refreshSuggestions();
  console.log(`        ${roster.fetched} enrolments`);

  console.log('\n  [3/6] One employee per enrolment');
  const created = await createEmployeesFromEnrolments();
  console.log(`        ${created.employees} employees, ${created.departments} departments`);

  console.log(`\n  [4/6] Punches — ${chunks.length} weekly requests, oldest first`);
  let fetched = 0, inserted = 0, failed = 0;
  for (const [i, w] of chunks.entries()) {
    process.stdout.write(`\r        ${i + 1}/${chunks.length}  ${w.from}  (${inserted} stored)          `);
    try {
      const r = await runTransactionSync({
        kind: 'backfill', source: 'backfill',
        startTime: new Date(`${w.from}T00:00:00+05:30`),
        endTime: new Date(`${w.to}T23:59:59+05:30`),
        advanceCursorAfter: false,
      });
      fetched += r.fetched; inserted += r.inserted;
    } catch (err) {
      failed += 1;
      logger.warn({ week: w, err: err instanceof Error ? err.message : String(err) }, 'chunk failed');
    }
  }
  console.log(`\r        ${fetched} seen, ${inserted} stored${failed ? `, ${failed} weeks failed` : ''}                    `);

  console.log('\n  [5/6] Join dates from each first punch');
  const jd = await prisma.$executeRawUnsafe(`
    update public.employees e
       set join_date = f.first_punch,
           meta = coalesce(e.meta, '{}'::jsonb) || jsonb_build_object('join_date_source', 'first punch')
      from (select employee_id, min((punch_time at time zone 'Asia/Kolkata')::date) first_punch
              from public.raw_punches where employee_id is not null group by employee_id) f
     where f.employee_id = e.id and e.join_date is null
  `);
  console.log(`        ${jd} set`);

  console.log('\n  [6/6] Building attendance across the whole range (the slow part)');
  const summary = await recompute({ from, to });
  console.log(`        ${summary.rowsWritten} rows for ${summary.employees} employees over ${summary.dates} dates`);

  console.log(`\n  Done. Undo is only possible from ${path.basename(file)}.`);
  console.log('  Holidays are still not configured, so public holidays across this range read as Absent.\n');
}

/** One employee per enrolment, filed under the single company, with the device's department. */
async function createEmployeesFromEnrolments(): Promise<{ employees: number; departments: number }> {
  const entity = await prisma.$queryRaw<Array<{ id: string }>>`select id from public.entities limit 1`;
  const entityId = entity[0]!.id;

  const enrolments = await prisma.$queryRaw<Array<{
    emp_code: string; full_name: string; department_name: string | null;
    position_name: string | null; hire_date: Date | null; is_active: boolean;
  }>>`
    select emp_code, full_name, department_name, position_name, hire_date, is_active
      from public.biotime_employees order by emp_code
  `;

  const real = (v: string | null) => {
    const s = String(v ?? '').trim();
    return !s || s === 'Department' || s === 'Position' ? null : s;
  };
  // "KASINATH A" -> "Kasinath A"; one- and two-letter tokens are initials and stay upper case.
  const tidy = (raw: string) => raw.trim().replace(/\s+/g, ' ').split(' ')
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');

  const deptIds = new Map<string, string>();
  for (const d of new Set(enrolments.map((e) => real(e.department_name)).filter(Boolean) as string[])) {
    const r = await prisma.$queryRaw<Array<{ id: string }>>`
      insert into public.departments (entity_id, name, is_active)
      values (${entityId}::uuid, ${d}, true) returning id
    `;
    deptIds.set(d.toUpperCase(), r[0]!.id);
  }

  let employees = 0;
  for (const e of enrolments) {
    // A device admin login is stored with its role as the name; not a person.
    const nm = real(e.full_name);
    if (!nm || nm.toUpperCase() === String(e.position_name ?? '').trim().toUpperCase()) continue;

    const dept = real(e.department_name);
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      insert into public.employees (entity_id, department_id, employee_code, full_name, join_date, status, meta)
      values (
        ${entityId}::uuid,
        ${dept ? deptIds.get(dept.toUpperCase()) ?? null : null}::uuid,
        ${`${'D'}${e.emp_code}`},
        ${tidy(e.full_name)},
        ${e.hire_date},
        ${e.is_active === false ? 'Inactive' : 'Active'},
        ${JSON.stringify({
          source: 'biotime', device_emp_code: e.emp_code, device_name: e.full_name,
          device_department: dept, device_position: real(e.position_name), needs_hr_review: true,
        })}::jsonb
      ) returning id
    `;
    const employeeId = rows[0]!.id;
    employees += 1;

    await prisma.$executeRaw`
      update public.biotime_employees
         set employee_id = ${employeeId}::uuid, link_status = 'manual', linked_at = now(), updated_at = now()
       where emp_code = ${e.emp_code}
    `;
  }

  return { employees, departments: deptIds.size };
}

const invoked = (process.argv[1] ?? '').split(/[\\/]/).pop() ?? '';
if (invoked === 'resetFromDevice.ts' || invoked === 'resetFromDevice.js') {
  main()
    .catch((err) => {
      console.error('\nFailed:', err instanceof Error ? err.message : String(err), '\n');
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect().catch(() => {});
      process.exit(process.exitCode ?? 0);
    });
}
