// Connectivity and sanity check. Run this FIRST, before any sync.
//
//   npm run doctor
//
// It answers with real data the two questions that silently corrupt everything if assumed wrong:
//
//   1. What do BioTime emp_codes actually look like, and do they match employees.employee_code?
//      (They very likely do not — the roster importer generates codes from Excel row numbers.)
//   2. Is the BioTime server's clock on the timezone BIOTIME_TIMEZONE claims? If it is on UTC
//      while we parse as IST, every punch lands 5h30m off and the whole engine is wrong.
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { prisma, assertDbReachable, disconnectDb } from '../lib/db';
import { biotime } from '../biotime/client';
import { fetchRecentTransactions } from '../biotime/transactions';
import { fetchAllEmployees, fetchAllTerminals } from '../biotime/employees';
import { parseBiotimeDateTime, formatLocalDateTime, APP_TZ, BIOTIME_TZ } from '../lib/time';
import { DateTime } from 'luxon';

const line = (label: string, value: unknown) =>
  console.log(`  ${label.padEnd(28)} ${value === null || value === undefined ? '—' : String(value)}`);

const heading = (text: string) => console.log(`\n${text}\n${'─'.repeat(text.length)}`);

async function main(): Promise<void> {
  let problems = 0;
  const warn = (msg: string) => {
    problems += 1;
    console.log(`  ⚠  ${msg}`);
  };

  heading('Configuration');
  line('BioTime URL', env.BIOTIME_BASE_URL);
  line('BioTime user', env.BIOTIME_USERNAME);
  line('BioTime timezone (assumed)', BIOTIME_TZ);
  line('Business timezone', APP_TZ);
  line('Poll schedule', env.SYNC_TRANSACTIONS_CRON);

  // --- database -------------------------------------------------------------
  heading('Database');
  try {
    await assertDbReachable();
    line('Connection', 'ok');

    const employeeCounts = await prisma.$queryRaw<Array<{ count: bigint }>>`
      select count(*)::bigint as count from public.employees where status = 'Active'
    `;
    line('Active employees', Number(employeeCounts[0]?.count ?? 0));

    const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
      select table_name from information_schema.tables
       where table_schema = 'public'
         and table_name in ('raw_punches','biotime_employees','devices','sync_state',
                            'sync_runs','shifts','attendance_regularizations','leave_types')
    `;
    const present = new Set(tables.map((t) => t.table_name));
    for (const t of ['raw_punches', 'biotime_employees', 'devices', 'sync_state', 'sync_runs']) {
      if (!present.has(t)) warn(`table public.${t} is missing — apply migration 0012_biotime.sql`);
    }
    if (!present.has('shifts')) warn('table public.shifts is missing — apply 0013_attendance_engine.sql');
    if (!present.has('leave_types')) warn('table public.leave_types is missing — apply 0014_leave_regularization.sql');
    if (present.size >= 8) line('Migrations 0012–0014', 'applied');
  } catch (err) {
    warn(`cannot reach the database: ${err instanceof Error ? err.message : String(err)}`);
    console.log('\nFix DATABASE_URL before continuing. Nothing else can be checked.\n');
    return;
  }

  // --- biotime --------------------------------------------------------------
  heading('BioTime connectivity');
  const ping = await biotime.ping();
  if (!ping.ok) {
    warn(`cannot reach BioTime: ${ping.error}`);
    console.log('\nFix BIOTIME_BASE_URL / credentials before continuing.\n');
    return;
  }
  line('Authentication', `ok (${ping.mode === 'jwt' ? 'JWT' : 'Token'} scheme)`);

  // --- terminals ------------------------------------------------------------
  heading('Terminals');
  const terminals = await fetchAllTerminals();
  if (terminals.length === 0) {
    console.log('  (no terminal list — devices will be created from incoming punches instead)');
  } else {
    for (const t of terminals.slice(0, 10)) {
      line(t.serialNumber, `${t.alias ?? '—'}  ${t.areaName ?? ''}  ${t.isActive ? '' : '[inactive]'}`);
    }
    if (terminals.length > 10) console.log(`  … and ${terminals.length - 10} more`);
  }

  // --- timezone sanity ------------------------------------------------------
  heading('Timezone check');
  const recent = await fetchRecentTransactions(5);

  if (recent.length === 0) {
    console.log('  (no transactions returned — cannot verify the clock)');
  } else {
    const newest = recent[0]!;
    console.log(`  Newest punch as BioTime reports it:  ${newest.punch_time}`);

    const parsed = parseBiotimeDateTime(newest.punch_time);
    if (parsed) {
      console.log(`  Interpreted as ${BIOTIME_TZ}, stored UTC: ${parsed.toISOString()}`);
      console.log(`  Displayed back in ${APP_TZ}:          ${formatLocalDateTime(parsed)}`);

      // A punch dated in the future, or absurdly old, is the signature of a timezone mismatch.
      const driftMinutes = (Date.now() - parsed.getTime()) / 60_000;
      if (driftMinutes < -15) {
        warn(
          `the newest punch is ${Math.abs(Math.round(driftMinutes))} minutes in the FUTURE. ` +
            `BIOTIME_TIMEZONE=${BIOTIME_TZ} is probably wrong — the BioTime server may be on UTC.`
        );
      } else if (driftMinutes > 60 * 24) {
        console.log(
          `  Note: newest punch is ${Math.round(driftMinutes / 60)}h old. Fine if the terminals ` +
            `are idle, worth a look if staff are punching right now.`
        );
      } else {
        line('Clock alignment', 'looks correct');
      }
    }
  }

  // --- emp_code reality check ------------------------------------------------
  heading('Employee code mapping');
  const devicePeople = await fetchAllEmployees();
  line('BioTime enrolments', devicePeople.length);

  const sampleCodes = devicePeople.slice(0, 8).map((p) => p.empCode);
  line('Sample emp_codes', sampleCodes.join(', ') || '—');

  const hrSample = await prisma.$queryRaw<Array<{ employee_code: string | null }>>`
    select employee_code from public.employees
     where employee_code is not null and status = 'Active'
     order by employee_code limit 8
  `;
  line('Sample employee_codes', hrSample.map((r) => r.employee_code).join(', ') || '—');

  if (devicePeople.length > 0) {
    const codes = devicePeople.map((p) => p.empCode);
    const matchRows = await prisma.$queryRaw<Array<{ matches: bigint }>>`
      select count(distinct e.employee_code)::bigint as matches
        from public.employees e
       where e.employee_code = any(${codes}::text[])
    `;

    const matched = Number(matchRows[0]?.matches ?? 0);
    line('Exact code matches', `${matched} of ${devicePeople.length}`);

    if (matched === 0) {
      console.log(
        `\n  BioTime codes do not correspond to employee_code — expected, since the roster\n` +
          `  importer generates those from Excel row numbers. Mapping happens by name suggestion\n` +
          `  in HR > Devices & Mapping. Run  npm run sync:employees  to populate the queue.`
      );
    } else if (matched < devicePeople.length / 2) {
      warn(`only ${matched} codes match — the rest need mapping in HR > Devices & Mapping`);
    }
  }

  // --- unmapped punches -------------------------------------------------------
  const orphanRows = await prisma.$queryRaw<Array<{ orphans: bigint }>>`
    select count(*)::bigint as orphans from public.raw_punches where employee_id is null
  `;
  const orphans = Number(orphanRows[0]?.orphans ?? 0);
  if (orphans > 0) {
    heading('Unmapped punches');
    warn(`${orphans} stored punches are not linked to an employee yet`);
  }

  // --- verdict ------------------------------------------------------------------
  heading('Result');
  if (problems === 0) {
    console.log('  All checks passed. Start the worker with:  npm run dev\n');
  } else {
    console.log(`  ${problems} issue(s) above need attention.\n`);
    process.exitCode = 1;
  }

  void DateTime;
}

main()
  .catch((err) => {
    logger.error({ err }, 'doctor failed');
    process.exitCode = 1;
  })
  .finally(() => void disconnectDb());
