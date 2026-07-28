// Configure our shift from Easy Time Pro's own timetable.
//
//   npm run shift:from-device            show what it has and what would change
//   npm run shift:from-device -- --apply write it into public.shifts
//   npm run shift:from-device -- --raw   dump the raw records too, for when a field is unrecognised
//
// MUST RUN ON THE MACHINE THAT CAN REACH EASY TIME PRO. It is a LAN service behind a firewall; no
// other computer can read its configuration, which is why this cannot be done from the web app.
//
// WHY BOTHER, WHEN THE PUNCHES ALREADY SHOW THE PATTERN
// Because the punches show what people did, and a shift is what they were meant to do. Ours is set
// to 09:30-18:30 while the median day actually runs 09:13-17:33, and the difference is not a
// rounding error: it flags 88% of days as leaving early and it decided, until recently, that almost
// nobody ever earned overtime. Easy Time Pro is where somebody originally wrote the real numbers
// down, so it is the source worth trusting over either our guess or a median.
//
// FIELD NAMES MOVE BETWEEN BUILDS. Each of our columns is read from the first field present out of
// several candidates, and anything not recognised is reported rather than silently defaulted — a
// wrong grace period quietly relabels people as late for months.
import { biotime } from '../biotime/client';
import { prisma } from '../lib/db';
import { logger } from '../lib/logger';
import { parseArgs, flag } from './args';
import { itemsOf, mapRecord, spanMinutes, type Rec } from '../sync/shiftMapping';

const APPLY_PATHS = [
  '/att/api/timeIntervals/', '/att/api/timeinterval/', '/att/api/timeIntervalList/',
  '/attendance/api/timeIntervals/', '/att/api/shifts/', '/att/api/shift/',
];

async function main(): Promise<void> {
  const args = parseArgs();
  const apply = flag(args, 'apply');
  const raw = flag(args, 'raw');

  console.log(`\n  Reading the timetable from ${biotime.baseUrl}\n`);

  const ping = await biotime.ping();
  if (!ping.ok) {
    console.log(`  Cannot reach Easy Time Pro: ${ping.error}`);
    console.log('  Run this on the machine where Easy Time Pro is installed.\n');
    process.exitCode = 1;
    return;
  }

  let found: { path: string; items: Rec[] } | null = null;
  for (const path of APPLY_PATHS) {
    try {
      const items = itemsOf(await biotime.get<unknown>(path, { page_size: 50 }));
      if (items.length) { found = { path, items }; break; }
    } catch {
      // Wrong spelling for this build; try the next.
    }
  }

  if (!found) {
    console.log('  No timetable is readable over the API on this build.');
    console.log('  Read it from the Easy Time Pro window instead (Attendance > Shift / Timetable)');
    console.log('  and set the numbers on the Shifts tab of the HR app.\n');
    process.exitCode = 1;
    return;
  }

  console.log(`  Found ${found.items.length} record(s) at ${found.path}\n`);
  const mapped = found.items.map((r) => mapRecord(r, found!.path));

  for (const m of mapped) {
    console.log(`  "${m.name ?? '(unnamed)'}"`);
    console.log(`      start ${m.startTime ?? 'not stated'}   end ${m.endTime ?? 'not stated'}` +
      `${m.workMinutes !== undefined ? `   work ${m.workMinutes}m` : ''}`);
    console.log(`      break ${m.breakMinutes ?? 'not stated'}   grace in ${m.graceIn ?? 'not stated'}` +
      `   grace out ${m.graceOut ?? 'not stated'}   min OT ${m.minOt ?? 'not stated'}`);
    if (m.unread.length) console.log(`      fields not recognised: ${m.unread.join(', ')}`);
    console.log('');
  }

  if (raw) {
    console.log('  RAW:');
    console.log(JSON.stringify(found.items[0], null, 2).split('\n').map((l) => '    ' + l).join('\n'));
    console.log('');
  }

  // Compare against what we run on today.
  const ours = await prisma.$queryRaw<Array<{
    id: string; code: string; name: string; start_time: string; end_time: string;
    break_minutes: number; grace_in_minutes: number; grace_out_minutes: number;
    full_day_minutes: number; half_day_minutes: number; min_ot_minutes: number;
  }>>`
    select id, code, name, start_time::text as start_time, end_time::text as end_time,
           break_minutes, grace_in_minutes, grace_out_minutes,
           full_day_minutes, half_day_minutes, min_ot_minutes
      from public.shifts where is_active order by code
  `;

  const best = mapped.find((m) => m.startTime && m.endTime) ?? mapped[0];
  if (!best?.startTime || !best.endTime) {
    console.log('  Easy Time Pro did not state both a start and an end time, so there is nothing');
    console.log('  safe to copy. Set the shift by hand from what is printed above.\n');
    process.exitCode = 1;
    return;
  }

  const span = spanMinutes(best.startTime!, best.endTime!);
  const brk = best.breakMinutes ?? 0;
  const fullDay = Math.max(1, span - brk);

  console.log('  WOULD CHANGE:\n');
  console.log(`    ${'field'.padEnd(20)} ${'ours'.padStart(12)} ${'Easy Time Pro'.padStart(14)}`);
  console.log('    ' + '-'.repeat(50));
  for (const s of ours) {
    const rows: [string, string | number, string | number | undefined][] = [
      ['start_time', s.start_time, best.startTime],
      ['end_time', s.end_time, best.endTime],
      ['break_minutes', s.break_minutes, brk],
      ['grace_in_minutes', s.grace_in_minutes, best.graceIn],
      ['grace_out_minutes', s.grace_out_minutes, best.graceOut],
      ['full_day_minutes', s.full_day_minutes, fullDay],
      ['half_day_minutes', s.half_day_minutes, Math.round(fullDay / 2)],
      ['min_ot_minutes', s.min_ot_minutes, best.minOt],
    ];
    console.log(`    [${s.code} ${s.name}]`);
    for (const [k, mine, theirs] of rows) {
      const differs = theirs !== undefined && String(mine) !== String(theirs);
      console.log(`    ${k.padEnd(20)} ${String(mine).padStart(12)} ${String(theirs ?? '—').padStart(14)}` +
        `${differs ? '   <- change' : ''}`);
    }
    console.log('');
  }

  if (!apply) {
    console.log('  Nothing written. Re-run with --apply to copy these into public.shifts.');
    console.log('  Then recompute so existing days are re-judged against the new times:');
    console.log('    npm run recompute -- --from <first date> --to <today>\n');
    return;
  }

  let changed = 0;
  for (const s of ours) {
    await prisma.$executeRaw`
      update public.shifts
         set start_time        = ${best.startTime}::time,
             end_time          = ${best.endTime}::time,
             break_minutes     = ${brk},
             grace_in_minutes  = coalesce(${best.graceIn ?? null}::int, grace_in_minutes),
             grace_out_minutes = coalesce(${best.graceOut ?? null}::int, grace_out_minutes),
             full_day_minutes  = ${fullDay},
             half_day_minutes  = ${Math.round(fullDay / 2)},
             min_ot_minutes    = coalesce(${best.minOt ?? null}::int, min_ot_minutes),
             updated_at        = now()
       where id = ${s.id}::uuid
    `;
    changed += 1;
  }

  console.log(`\n  Updated ${changed} shift(s) from Easy Time Pro.`);
  console.log('  Now re-judge the days already recorded:');
  console.log('    npm run recompute -- --from 2026-07-21 --to 2026-07-28\n');
  logger.info({ startTime: best.startTime, endTime: best.endTime, breakMinutes: brk, fullDay }, 'shift copied from device');
}

main()
  .catch((err) => {
    console.error('\nFailed:', err instanceof Error ? err.message : String(err), '\n');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
    process.exit(process.exitCode ?? 0);
  });
