// Find out what Easy Time Pro already knows about shifts, breaks and overtime.
//
//   npm run probe:rules            what is configured, in readable form
//   npm run probe:rules -- --raw   plus the raw JSON of the first record from each endpoint
//
// WHY
// The shift in our database (09:30-18:30, 60m break, 7h full day) was entered by hand, and it does
// not match what people actually do — the median day runs 09:13 to 17:33, which flags 88% of days
// as leaving early. Rather than guessing better numbers, read the ones Easy Time Pro is already
// enforcing: it has its own shift definitions, break rules and overtime thresholds, and those are
// what the terminals and any existing payroll reports have been using all along.
//
// Nothing is written. This only reads, and prints what it finds.
//
// Endpoint names move around between BioTime/Easy Time Pro builds, so several spellings of each
// idea are tried and whichever answers is reported. A 404 here is information, not a failure.
import { biotime } from '../biotime/client';
import { logger } from '../lib/logger';
import { parseArgs, flag } from './args';

interface Candidate {
  what: string;
  paths: string[];
}

const CANDIDATES: Candidate[] = [
  { what: 'Time intervals (the actual start/end/break/OT numbers)', paths: [
    '/att/api/timeIntervals/', '/att/api/timeinterval/', '/att/api/timeIntervalList/', '/attendance/api/timeIntervals/',
  ]},
  { what: 'Shifts', paths: [
    '/att/api/shifts/', '/att/api/shift/', '/attendance/api/shifts/',
  ]},
  { what: 'Schedules (who works which shift)', paths: [
    '/att/api/schedules/', '/att/api/employeeSchedules/', '/att/api/schedule/', '/attendance/api/schedules/',
  ]},
  { what: 'Break times', paths: [
    '/att/api/breakTimes/', '/att/api/breakTime/', '/att/api/breaks/',
  ]},
  { what: 'Overtime rules / pay codes', paths: [
    '/att/api/payCodes/', '/att/api/overtimes/', '/att/api/overtime/', '/att/api/otRules/',
  ]},
  { what: 'Holidays', paths: [
    '/att/api/holidays/', '/att/api/holiday/', '/personnel/api/holidays/',
  ]},
  { what: 'Leave types', paths: [
    '/att/api/leaveTypes/', '/att/api/leaveType/',
  ]},
  { what: 'Departments', paths: [
    '/personnel/api/departments/',
  ]},
];

/** Pull the item list out of whichever envelope this build uses. */
function itemsOf(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  const b = body as { data?: unknown; results?: unknown; count?: number };
  if (Array.isArray(b?.data)) return b.data;
  if (Array.isArray(b?.results)) return b.results;
  return [];
}

/** Show a record compactly: the fields worth reading, then anything else that looks like a number. */
function describe(item: Record<string, unknown>): string {
  const interesting = [
    'id', 'alias', 'name', 'shift_name', 'time_name', 'code',
    'in_time', 'out_time', 'start_time', 'end_time', 'work_time_duration', 'work_day',
    'late_in', 'early_out', 'in_ahead_margin', 'out_ahead_margin', 'in_above_margin', 'out_above_margin',
    'break_time', 'rest_time', 'use_rest_time', 'available_interval',
    'overtime_level', 'ot_level', 'min_ot', 'workday_ot', 'weekend_ot', 'holiday_ot',
    'day_off', 'weekend', 'auto_overtime', 'shift_cycle', 'cycle_unit', 'period_start',
  ];
  const parts: string[] = [];
  for (const k of interesting) {
    if (item[k] !== undefined && item[k] !== null && item[k] !== '') {
      parts.push(`${k}=${JSON.stringify(item[k])}`);
    }
  }
  return parts.length ? parts.join('  ') : JSON.stringify(item).slice(0, 200);
}

async function main(): Promise<void> {
  const args = parseArgs();
  const raw = flag(args, 'raw');

  console.log(`\n  Reading configuration from ${biotime.baseUrl}\n`);

  const ping = await biotime.ping();
  if (!ping.ok) {
    console.log(`  Cannot reach Easy Time Pro: ${ping.error}`);
    console.log('  Run this on the machine where Easy Time Pro is installed.\n');
    process.exitCode = 1;
    return;
  }
  console.log(`  Connected (auth mode: ${ping.mode})\n`);

  const found: string[] = [];

  for (const c of CANDIDATES) {
    let done = false;

    for (const path of c.paths) {
      if (done) break;
      try {
        const body = await biotime.get<unknown>(path, { page_size: 50 });
        const items = itemsOf(body);
        const total = (body as { count?: number })?.count ?? items.length;

        console.log(`  ${c.what}`);
        console.log(`    ${path}  ->  ${total} record(s)`);

        if (items.length === 0) {
          console.log('    (endpoint exists but is empty — nothing configured here)\n');
        } else {
          for (const item of items.slice(0, 12)) {
            console.log(`      ${describe(item as Record<string, unknown>)}`);
          }
          if (items.length > 12) console.log(`      … and ${items.length - 12} more`);
          if (raw) {
            console.log(`\n    raw first record:\n${JSON.stringify(items[0], null, 2).split('\n').map((l) => '      ' + l).join('\n')}`);
          }
          console.log('');
        }

        found.push(`${c.what}: ${path} (${total})`);
        done = true;
      } catch (err) {
        // 404 just means this build spells it differently; keep trying the alternatives.
        const status = (err as { status?: number; response?: { status?: number } })?.status
          ?? (err as { response?: { status?: number } })?.response?.status;
        if (status && status !== 404) {
          logger.debug({ path, status }, 'endpoint returned an error');
        }
      }
    }

    if (!done) {
      console.log(`  ${c.what}`);
      console.log(`    not available on this build (tried ${c.paths.length} spellings)\n`);
    }
  }

  console.log('  ---');
  if (found.length === 0) {
    console.log('  Nothing found. This build may not expose attendance rules over the API —');
    console.log('  read them from the Easy Time Pro UI instead (Attendance > Shift / Time table).\n');
  } else {
    console.log(`  ${found.length} of ${CANDIDATES.length} kinds of configuration are readable.`);
    console.log('  Send this output back and the shift, break and overtime numbers can be');
    console.log('  copied into the HR system so both agree.\n');
  }
}

main()
  .catch((err) => {
    console.error('\nFailed:', err instanceof Error ? err.message : String(err), '\n');
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
