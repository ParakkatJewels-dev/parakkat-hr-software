// Re-run the attendance engine over a date range.
//
//   npm run recompute -- --from 2026-07-01 --to 2026-07-31
//   npm run recompute -- --month 2026-07
//   npm run recompute -- --from 2026-07-01 --to 2026-07-31 --employee <uuid>
//   npm run recompute -- --today
//   npm run recompute -- --queue          (drain pending corrections only)
//
// Idempotent: run it as often as rules change. Rows flagged is_locked (finalized payroll) are
// skipped unless --include-locked is passed.
import { logger } from '../lib/logger';
import { assertDbReachable, disconnectDb } from '../lib/db';
import { recompute, drainRecomputeQueue } from '../engine/recompute';
import { todayWorkDate, monthBounds, DateTime, APP_TZ } from '../lib/time';
import { parseArgs, parseDate, flag, list } from './args';

async function main(): Promise<void> {
  const args = parseArgs();

  if (flag(args, 'help')) {
    console.log(`
Re-run the attendance engine.

  --from YYYY-MM-DD    start date
  --to   YYYY-MM-DD    end date (default: --from)
  --month YYYY-MM      shorthand for a whole calendar month
  --today              just today
  --employee <uuid>    limit to one employee (repeatable via comma-separated list)
  --queue              drain the pending recompute queue and exit
  --include-locked     also overwrite rows locked by payroll finalisation

Examples:
  npm run recompute -- --month 2026-07
  npm run recompute -- --from 2026-07-01 --to 2026-07-15
`);
    return;
  }

  await assertDbReachable();

  if (flag(args, 'queue')) {
    const summary = await drainRecomputeQueue();
    if (!summary) {
      logger.info('recompute queue is empty');
    } else {
      logger.info(summary, 'queue drained');
    }
    return;
  }

  let from: string;
  let to: string;

  if (flag(args, 'today')) {
    from = to = todayWorkDate();
  } else if (typeof args.month === 'string') {
    const dt = DateTime.fromISO(`${args.month}-01`, { zone: APP_TZ });
    if (!dt.isValid) throw new Error(`--month "${args.month}" is not valid (expected YYYY-MM)`);
    ({ from, to } = monthBounds(dt.year, dt.month));
  } else if (typeof args.from === 'string') {
    from = parseDate(args.from, 'from');
    to = typeof args.to === 'string' ? parseDate(args.to, 'to') : from;
  } else {
    throw new Error('one of --from, --month, --today or --queue is required (see --help)');
  }

  const employeeIds = list(args, 'employee');

  logger.info(
    { from, to, employees: employeeIds.length || 'all', includeLocked: flag(args, 'include-locked') },
    'recomputing attendance'
  );

  const summary = await recompute({
    from,
    to,
    employeeIds: employeeIds.length ? employeeIds : undefined,
    includeLocked: flag(args, 'include-locked'),
  });

  logger.info(summary, 'recompute complete');

  if (summary.skippedLocked > 0) {
    logger.warn(
      { skipped: summary.skippedLocked },
      'some rows were locked and left untouched — pass --include-locked to overwrite them'
    );
  }
}

main()
  .catch((err) => {
    logger.error({ err }, 'recompute failed');
    process.exitCode = 1;
  })
  .finally(() => void disconnectDb());
