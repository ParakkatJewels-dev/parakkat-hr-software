// Pull everything Easy Time Pro has, in the order that produces correct data.
//
//   npm run fetch:all                        from 12 months back to today
//   npm run fetch:all -- --from 2025-09-01
//   npm run fetch:all -- --from 2025-09-01 --dry
//   npm run fetch:all -- --resume            skip weeks already fully collected
//
// MUST RUN ON THE MACHINE THAT REACHES EASY TIME PRO. It is a LAN service behind a firewall.
//
// THE ORDER MATTERS, and getting it wrong is not obvious afterwards:
//
//   1. roster      so a punch arriving in step 3 has somebody to attach to
//   2. timetable   reported, never applied — changing the shift changes everyone's pay, and that
//                  is a decision, not a fetch. `npm run shift:from-device` does it deliberately
//   3. punches     oldest first, a week at a time
//   4. join dates  ONLY NOW. Derived from each person's first punch, which is meaningless until
//                  the history exists — run before step 3 and it stamps everybody with the day the
//                  sync happened to start
//   5. recompute   turn the punches into attendance, skipping days before each person joined
//
// Chunked weekly on purpose. Asking BioTime for a year in one query is how you get a timeout, or
// take the terminal server down during business hours. Each week is a separate request and a
// separate sync_runs row, so an interrupted run resumes from where it stopped rather than
// restarting.
import { biotime } from '../biotime/client';
import { prisma } from '../lib/db';
import { logger } from '../lib/logger';
import { runTransactionSync } from '../sync/syncTransactions';
import { syncEmployees, refreshSuggestions } from '../sync/syncEmployees';
import { recompute } from '../engine/recompute';
import { itemsOf, mapRecord } from '../sync/shiftMapping';
import { todayWorkDate, DateTime, APP_TZ } from '../lib/time';
import { parseArgs, flag } from './args';
import { earliestPunchDate } from '../sync/earliest';

const CHUNK_DAYS = 7;

const TIMETABLE_PATHS = [
  '/att/api/timeIntervals/', '/att/api/timeinterval/', '/att/api/shifts/', '/att/api/shift/',
];

export function weeks(from: string, to: string): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  let cursor = DateTime.fromISO(from, { zone: APP_TZ });
  const end = DateTime.fromISO(to, { zone: APP_TZ });
  while (cursor <= end) {
    const chunkEnd = DateTime.min(cursor.plus({ days: CHUNK_DAYS - 1 }), end);
    out.push({ from: cursor.toFormat('yyyy-MM-dd'), to: chunkEnd.toFormat('yyyy-MM-dd') });
    cursor = chunkEnd.plus({ days: 1 });
  }
  return out;
}

/** Set join_date from the first punch, for anyone HR has not recorded one for. */
async function deriveJoinDates(dry: boolean): Promise<{ set: number; unknown: number; floor: string | null }> {
  const rows = await prisma.$queryRaw<Array<{ id: string; first_punch: string; punches: bigint }>>`
    select e.id,
           to_char(min(p.punch_time at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD') as first_punch,
           count(p.id) as punches
      from public.employees e
      join public.raw_punches p on p.employee_id = e.id
     where e.join_date is null
     group by e.id
  `;
  const unknownRows = await prisma.$queryRaw<Array<{ n: bigint }>>`
    select count(*) as n from public.employees e
     where e.join_date is null
       and not exists (select 1 from public.raw_punches p where p.employee_id = e.id)
  `;
  const unknown = Number(unknownRows[0]?.n ?? 0);

  const floor = rows.reduce<string | null>((a, r) => (!a || r.first_punch < a ? r.first_punch : a), null);

  if (!dry) {
    for (const r of rows) {
      await prisma.$executeRaw`
        update public.employees
           set join_date = ${r.first_punch}::date,
               meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('join_date_source', 'first punch')
         where id = ${r.id}::uuid and join_date is null
      `;
    }
  }
  return { set: rows.length, unknown, floor };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const dry = flag(args, 'dry');
  const resume = flag(args, 'resume');

  const to = todayWorkDate();
  // Ask the terminal how far back it goes rather than assuming. Only fall back to a wide window
  // if it will not say.
  const discovered = typeof args.from === 'string' ? null : await earliestPunchDate();
  const from = typeof args.from === 'string'
    ? args.from
    : discovered ?? DateTime.fromISO(to, { zone: APP_TZ }).minus({ months: 12 }).toFormat('yyyy-MM-dd');

  console.log(`\n  Fetching everything from ${biotime.baseUrl}`);
  console.log(`  Range ${from} .. ${to}${dry ? '   (DRY RUN — nothing written)' : ''}`);
  console.log(discovered
    ? `  ${from} is the oldest transaction Easy Time Pro holds.\n`
    : `  (the oldest transaction could not be read; using a 12-month window)\n`);

  const ping = await biotime.ping();
  if (!ping.ok) {
    console.log(`  Cannot reach Easy Time Pro: ${ping.error}`);
    console.log('  Run this on the machine where Easy Time Pro is installed.\n');
    process.exitCode = 1;
    return;
  }

  // --- 1. roster --------------------------------------------------------------------------
  console.log('  [1/5] Roster and terminals');
  if (dry) {
    console.log('        would sync employees and refresh match suggestions\n');
  } else {
    const r = await syncEmployees();
    const suggested = await refreshSuggestions();
    console.log(`        ${r.fetched} enrolments, ${r.created} new, ${r.updated} updated, ${suggested} suggestions refreshed\n`);
  }

  // --- 2. timetable, reported only --------------------------------------------------------
  console.log('  [2/5] Timetable');
  let sawTimetable = false;
  for (const path of TIMETABLE_PATHS) {
    try {
      const items = itemsOf(await biotime.get<unknown>(path, { page_size: 50 }));
      if (!items.length) continue;
      sawTimetable = true;
      for (const m of items.map((i) => mapRecord(i, path))) {
        console.log(`        "${m.name ?? '(unnamed)'}"  ${m.startTime ?? '?'} - ${m.endTime ?? '?'}` +
          `  break ${m.breakMinutes ?? '?'}  grace in ${m.graceIn ?? '?'} out ${m.graceOut ?? '?'}`);
      }
      break;
    } catch {
      // Different spelling on this build; try the next.
    }
  }
  if (!sawTimetable) console.log('        not readable over the API on this build');
  // Deliberately not applied: the shift decides everyone's paid hours and half-day boundary.
  console.log('        NOT applied — run `npm run shift:from-device` to adopt these deliberately\n');

  // --- 3. punches -------------------------------------------------------------------------
  const chunks = weeks(from, to);
  console.log(`  [3/5] Punches — ${chunks.length} weekly chunks`);

  let fetched = 0;
  let inserted = 0;
  let failures = 0;

  for (const [i, w] of chunks.entries()) {
    if (resume && !dry) {
      // A week already collected is one where a backfill run covering it finished successfully.
      const done = await prisma.$queryRaw<Array<{ n: bigint }>>`
        select count(*) as n from public.sync_runs
         where kind = 'backfill' and status = 'success'
           and (cursor_before->>'startTime')::date <= ${w.from}::date
           and (cursor_before->>'endTime')::date   >= ${w.to}::date
      `;
      if (Number(done[0]?.n ?? 0) > 0) {
        process.stdout.write(`\r        ${i + 1}/${chunks.length}  ${w.from}  already collected            `);
        continue;
      }
    }

    process.stdout.write(`\r        ${i + 1}/${chunks.length}  ${w.from} .. ${w.to}                    `);
    if (dry) continue;

    try {
      const r = await runTransactionSync({
        kind: 'backfill',
        source: 'backfill',
        startTime: new Date(`${w.from}T00:00:00+05:30`),
        endTime: new Date(`${w.to}T23:59:59+05:30`),
        // A backfill of last March must never drag the live cursor backwards and make the
        // incremental poll re-read four months.
        advanceCursorAfter: false,
      });
      fetched += r.fetched;
      inserted += r.inserted;
    } catch (err) {
      failures += 1;
      logger.warn({ week: w, err: err instanceof Error ? err.message : String(err) }, 'chunk failed');
      process.stdout.write(`\r        ${i + 1}/${chunks.length}  ${w.from} FAILED — continuing        \n`);
    }
  }
  console.log(`\r        ${fetched} punches seen, ${inserted} new${failures ? `, ${failures} chunk(s) failed` : ''}                    \n`);

  if (dry) {
    console.log('  [4/5] Join dates   — skipped in a dry run');
    console.log('  [5/5] Attendance   — skipped in a dry run\n');
    console.log('  Re-run without --dry to collect.\n');
    return;
  }

  // --- 4. join dates ----------------------------------------------------------------------
  console.log('  [4/5] Join dates from first punch');
  const jd = await deriveJoinDates(false);
  console.log(`        set ${jd.set}, still unknown ${jd.unknown} (no punches at all)`);
  if (jd.floor) {
    console.log(`        earliest punch in the data is ${jd.floor} — anyone whose join date`);
    console.log('        equals that was already employed when recording began, not hired that day');
  }
  console.log('');

  // --- 5. attendance ----------------------------------------------------------------------
  console.log('  [5/5] Building attendance across the range (this is the slow part)');
  const summary = await recompute({ from, to });
  console.log(`        ${summary.rowsWritten} day-rows for ${summary.employees} employees over ${summary.dates} dates\n`);

  console.log('  Done.');
  console.log('  Two things worth knowing:');
  console.log('    - holidays are not configured, so public holidays across this range read as Absent');
  console.log('    - the shift was NOT changed; if Easy Time Pro disagrees with it, adopt it with');
  console.log('      `npm run shift:from-device -- --apply` and recompute again\n');
}

// Guarded so importing this module for a test does not start a fetch. Without it, `import { weeks }`
// dials BioTime and backfills a year — which is how an earlier test spent three minutes trying to
// reach a firewalled address before failing.
// Compiles to CommonJS, so `import.meta` is unavailable. Match the exact file being run, not a
// substring: `includes('fetchAll')` is also true for fetchAll.test.ts, which made importing the
// module for a test start a real twelve-month backfill.
const invoked = (process.argv[1] ?? '').split(/[\\/]/).pop() ?? '';
const isEntryPoint = invoked === 'fetchAll.ts' || invoked === 'fetchAll.js';

if (isEntryPoint) {
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
