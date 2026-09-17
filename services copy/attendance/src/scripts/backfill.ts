// Historical punch backfill.
//
//   npm run backfill -- --from 2026-01-01 --to 2026-03-31
//   npm run backfill -- --from 2026-01-01 --to 2026-06-30 --chunk 3 --recompute
//
// Pulls a date range from BioTime in chunks and stores it. Safe to re-run over a range that is
// already synced: the (emp_code, punch_time) unique constraint discards the repeats.
//
// Chunking matters. Asking BioTime for six months in one query makes it build an enormous result
// set, and on a modest on-prem box that is how you get a timeout — or take the terminal server
// down during business hours. A few days at a time keeps each request small and lets the run
// resume from where it stopped.
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { assertDbReachable, disconnectDb } from '../lib/db';
import { runTransactionSync } from '../sync/syncTransactions';
import { recompute } from '../engine/recompute';
import { workDateStart, workDateEnd, eachWorkDate, DateTime, APP_TZ } from '../lib/time';
import { parseArgs, requireDate, optionalDate, flag, num } from './args';

async function main(): Promise<void> {
  const args = parseArgs();

  if (flag(args, 'help')) {
    console.log(`
Backfill historical punches from BioTime.

  --from YYYY-MM-DD   start date (required)
  --to   YYYY-MM-DD   end date   (default: today)
  --chunk N           days per request batch (default 7)
  --recompute         run the attendance engine over the range afterwards
  --quiet             less logging

Examples:
  npm run backfill -- --from 2026-01-01 --to 2026-03-31
  npm run backfill -- --from 2026-06-01 --recompute
`);
    return;
  }

  const from = requireDate(args, 'from');
  const to = optionalDate(args, 'to', DateTime.now().setZone(APP_TZ).toFormat('yyyy-MM-dd'));
  const chunkDays = Math.max(1, num(args, 'chunk', 7));

  if (from > to) throw new Error(`--from (${from}) is after --to (${to})`);

  await assertDbReachable();

  const allDates = eachWorkDate(from, to);
  const totals = { inserted: 0, fetched: 0, skipped: 0, unmatched: 0 };
  const chunks: Array<{ from: string; to: string }> = [];

  for (let i = 0; i < allDates.length; i += chunkDays) {
    const slice = allDates.slice(i, i + chunkDays);
    chunks.push({ from: slice[0]!, to: slice[slice.length - 1]! });
  }

  logger.info(
    { from, to, days: allDates.length, chunks: chunks.length, chunkDays },
    'starting backfill'
  );

  let failures = 0;

  for (const [index, chunk] of chunks.entries()) {
    const label = `${chunk.from} .. ${chunk.to}`;
    try {
      const result = await runTransactionSync({
        kind: 'backfill',
        source: 'backfill',
        startTime: workDateStart(chunk.from),
        endTime: workDateEnd(chunk.to),
        // A backfill looks at history; it must never drag the live cursor backwards.
        advanceCursorAfter: false,
        maxPages: 10_000,
      });

      totals.inserted += result.inserted;
      totals.fetched += result.fetched;
      totals.skipped += result.skipped;
      totals.unmatched = Math.max(totals.unmatched, result.unmatched);

      logger.info(
        { chunk: `${index + 1}/${chunks.length}`, range: label, ...result },
        'backfill chunk done'
      );
    } catch (err) {
      // Keep going: one bad window should not cost the other five months. The chunk is reported
      // at the end so it can be re-run on its own.
      failures += 1;
      logger.error({ err, range: label }, 'backfill chunk FAILED — continuing with the next');
    }
  }

  logger.info({ ...totals, chunksFailed: failures }, 'backfill complete');

  if (totals.unmatched > 0) {
    logger.warn(
      'some punches were stored against emp_codes with no linked employee. ' +
        'Map them in HR > Devices & Mapping, then re-run the engine for this range.'
    );
  }

  if (flag(args, 'recompute')) {
    logger.info({ from, to }, 'running the attendance engine over the backfilled range');
    const summary = await recompute({ from, to });
    logger.info(summary, 'recompute complete');
  } else {
    logger.info(
      `punches stored. Run the engine when ready:  npm run recompute -- --from ${from} --to ${to}`
    );
  }

  if (failures > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    logger.error({ err }, 'backfill failed');
    process.exitCode = 1;
  })
  .finally(() => void disconnectDb());

// Referenced so the unused-import lint stays quiet about env, which is loaded for its side effect
// of validating configuration before anything touches BioTime.
void env;
