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
import { drainServiceCommands } from './commands';
import { todayWorkDate, DateTime, APP_TZ } from '../lib/time';

const running = new Map<string, { since: number; abort: AbortController }>();
const tasks: ScheduledTask[] = [];

/**
 * How long a single run may take before it is abandoned.
 *
 * This exists because "skip the tick if one is already running" is only safe if a run is guaranteed
 * to end. It is not. When the laptop changes network — Wi-Fi to LAN, or the terminal's switch
 * reboots — sockets that were already open are black-holed: packets go nowhere and no RST comes
 * back, so a read can sit there long past any per-request timeout. That happened here: a
 * transactions run started at 13:18 and never returned, so every tick for the next sixteen hours
 * logged "previous run still in progress — skipping" and nothing synced until somebody restarted
 * the service. Failing loudly after a bounded wait is always better than waiting forever.
 */
export const JOB_DEADLINE_MS: Record<string, number> = {
  'sync:transactions': 10 * 60_000,
  'sync:employees': 15 * 60_000,
  'engine:nightly': 60 * 60_000,
  'engine:queue': 10 * 60_000,
  'service:commands': 30 * 60_000,
  'engine:today': 10 * 60_000,
};
const DEFAULT_DEADLINE_MS = 15 * 60_000;

/** Run `fn` unless a run of the same name is already in flight, and never let it run forever. */
export async function exclusive(name: string, fn: (signal: AbortSignal) => Promise<unknown>): Promise<void> {
  const current = running.get(name);
  if (current) {
    const minutes = Math.round((Date.now() - current.since) / 60_000);
    logger.warn({ job: name, runningForMinutes: minutes }, 'previous run still in progress — skipping this tick');
    return;
  }

  const abort = new AbortController();
  const deadline = JOB_DEADLINE_MS[name] ?? DEFAULT_DEADLINE_MS;
  running.set(name, { since: Date.now(), abort });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => {
      logger.error({ job: name, deadlineMs: deadline }, 'job exceeded its deadline — abandoning it so the next tick can run');
      abort.abort();
      resolve('deadline');
    }, deadline);
    // A pending deadline must not be what keeps the process alive.
    timer.unref?.();
  });

  // Start the work, then RACE it against the deadline rather than awaiting it directly.
  //
  // Awaiting `fn` and merely firing the abort signal is not enough, and that distinction is the
  // whole fix: aborting asks the job to stop, it cannot make a socket read that is waiting on a
  // dead network return. If the job ignores the signal, `await fn(...)` never settles, the finally
  // block never runs, and the lock stays held — which is precisely the failure this was written to
  // prevent. Racing means the lock is released on the deadline whether the job cooperates or not.
  const work = fn(abort.signal);

  // The abandoned promise still has to be handled. index.ts treats an unhandled rejection as fatal
  // and exits, so a job that rejects ten minutes after being abandoned would kill the service.
  const settled = work.then(
    () => 'done' as const,
    (err) => {
      logger.error({ err, job: name }, 'scheduled job failed');
      return 'failed' as const;
    }
  );

  const outcome = await Promise.race([settled, expired]);

  clearTimeout(timer);
  running.delete(name);

  if (outcome === 'deadline') {
    // Releasing the lock can let the next tick start while the abandoned run is technically still
    // in flight. That is deliberate and safe here: the cursor only advances on success and punch
    // inserts are idempotent, so at worst two runs read the same window. A duplicate read costs
    // one query; never syncing again costs a day of attendance.
    logger.warn({ job: name }, 'lock released — a later tick will retry this job');
  }
}

function schedule(name: string, expression: string, fn: (signal: AbortSignal) => Promise<unknown>): void {
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
  schedule('sync:transactions', env.SYNC_TRANSACTIONS_CRON, (signal) => syncTransactions(signal));

  // 2. Roster + terminals, daily.
  schedule('sync:employees', env.SYNC_EMPLOYEES_CRON, (signal) => syncEmployees(signal));

  // 3. Nightly: catch late uploads, then re-derive the trailing window, then tidy up.
  //    Order matters — recomputing before the catch-up would use punches that are about to change.
  schedule('engine:nightly', env.ENGINE_CRON, async (signal) => {
    await catchUpTransactions(env.SYNC_CATCHUP_DAYS, signal);

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

  // 5. Work asked for from the admin screen. Every 20 seconds, because somebody is watching a
  //    spinner when they press one of those buttons — unlike the other jobs here, this one has a
  //    person waiting on it.
  schedule('service:commands', '*/20 * * * * *', (signal) => drainServiceCommands(signal));

  // 6. Keep today's attendance current through the day, so the "who's in today" view and the
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
  return [...running.keys()];
}
