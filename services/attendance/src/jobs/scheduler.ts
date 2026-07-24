// Scheduled work. node-cron, with one guard that matters: jobs never overlap themselves.
//
// Without the guard, a transaction sync that takes longer than the poll interval — which happens
// the first time someone runs a big backfill, or when BioTime is slow — would stack up runs that
// all query the same window and fight over the cursor. Skipping a tick is always the right answer;
// the next one picks up the same work.
import cron, { ScheduledTask } from 'node-cron';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { syncTransactions, catchUpTransactions } from '../sync/syncTransactions';
import { syncEmployees } from '../sync/syncEmployees';
import { drainRecomputeQueue, recompute } from '../engine/recompute';
import { pruneRuns } from '../sync/runLog';
import { todayWorkDate, DateTime, APP_TZ } from '../lib/time';

const running = new Set<string>();
const tasks: ScheduledTask[] = [];

/** Run `fn` unless a run of the same name is already in flight. */
async function exclusive(name: string, fn: () => Promise<unknown>): Promise<void> {
  if (running.has(name)) {
    logger.warn({ job: name }, 'previous run still in progress — skipping this tick');
    return;
  }

  running.add(name);
  try {
    await fn();
  } catch (err) {
    // Never let a job throw out of the cron callback: an unhandled rejection here would take the
    // whole worker process down and stop every other schedule with it.
    logger.error({ err, job: name }, 'scheduled job failed');
  } finally {
    running.delete(name);
  }
}

function schedule(name: string, expression: string, fn: () => Promise<unknown>): void {
  if (!cron.validate(expression)) {
    logger.error({ job: name, expression }, 'invalid cron expression — job not scheduled');
    return;
  }

  const task = cron.schedule(expression, () => void exclusive(name, fn), {
    timezone: APP_TZ,
  });

  tasks.push(task);
  logger.info({ job: name, expression, timezone: APP_TZ }, 'job scheduled');
}

export function startScheduler(): void {
  if (!env.ENABLE_WORKERS) {
    logger.warn('ENABLE_WORKERS=false — running API only, no scheduled jobs');
    return;
  }

  // 1. The live punch pull.
  schedule('sync:transactions', env.SYNC_TRANSACTIONS_CRON, () => syncTransactions());

  // 2. Roster + terminals, daily.
  schedule('sync:employees', env.SYNC_EMPLOYEES_CRON, () => syncEmployees());

  // 3. Nightly: catch late uploads, then re-derive the trailing window, then tidy up.
  //    Order matters — recomputing before the catch-up would use punches that are about to change.
  schedule('engine:nightly', env.ENGINE_CRON, async () => {
    await catchUpTransactions();

    const to = todayWorkDate();
    const from = DateTime.fromISO(to, { zone: APP_TZ })
      .minus({ days: env.ENGINE_LOOKBACK_DAYS })
      .toFormat('yyyy-MM-dd');

    await recompute({ from, to });
    await drainRecomputeQueue();
    await pruneRuns(90);
  });

  // 4. Drain the recompute queue often, so an approved leave or regularization shows up in the
  //    calendar within minutes rather than overnight.
  schedule('engine:queue', '*/5 * * * *', () => drainRecomputeQueue());

  // 5. Keep today's attendance current through the day, so the "who's in today" view and the
  //    exceptions list reflect punches as they arrive rather than only after the nightly pass.
  schedule('engine:today', '*/15 * * * *', () => {
    const today = todayWorkDate();
    return recompute({ from: today, to: today });
  });
}

export function stopScheduler(): void {
  for (const task of tasks) task.stop();
  tasks.length = 0;
  logger.info('scheduler stopped');
}

/** True while any job is mid-run — used by the shutdown path to drain before exiting. */
export function jobsInFlight(): string[] {
  return [...running];
}
