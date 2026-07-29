// One row in public.sync_runs per sync attempt.
//
// This is the audit trail the brief asks for ("log every sync run's outcome") and the data behind
// the Phase 5 admin status page. It is written even when the run fails — especially then.
import { prisma } from '../lib/db';
import { logger } from '../lib/logger';

export type RunKind = 'transactions' | 'employees' | 'devices' | 'backfill' | 'catchup' | 'engine';
export type RunStatus = 'running' | 'success' | 'partial' | 'failed';

export interface RunCounters {
  pagesFetched: number;
  recordsFetched: number;
  recordsInserted: number;
  recordsSkipped: number;
  unmatchedCodes: number;
}

export function emptyCounters(): RunCounters {
  return {
    pagesFetched: 0,
    recordsFetched: 0,
    recordsInserted: 0,
    recordsSkipped: 0,
    unmatchedCodes: 0,
  };
}

export class SyncRun {
  readonly counters: RunCounters = emptyCounters();
  private readonly startedAt = Date.now();
  private detail: Record<string, unknown> = {};

  private constructor(
    readonly id: bigint,
    readonly kind: RunKind
  ) {}

  static async start(kind: RunKind, cursorBefore?: unknown): Promise<SyncRun> {
    const row = await prisma.syncRun.create({
      data: {
        kind,
        status: 'running',
        cursorBefore: cursorBefore ? (JSON.parse(JSON.stringify(cursorBefore)) as object) : undefined,
      },
      select: { id: true },
    });
    return new SyncRun(row.id, kind);
  }

  addDetail(patch: Record<string, unknown>): void {
    this.detail = { ...this.detail, ...patch };
  }

  async finish(status: Exclude<RunStatus, 'running'>, opts: { cursorAfter?: unknown; error?: unknown } = {}): Promise<void> {
    const durationMs = Date.now() - this.startedAt;
    const errorMessage =
      opts.error instanceof Error ? opts.error.message : opts.error ? String(opts.error) : null;

    try {
      await prisma.syncRun.update({
        where: { id: this.id },
        data: {
          status,
          finishedAt: new Date(),
          durationMs,
          ...this.counters,
          cursorAfter: opts.cursorAfter ? (JSON.parse(JSON.stringify(opts.cursorAfter)) as object) : undefined,
          errorMessage: errorMessage?.slice(0, 4_000) ?? null,
          detail: Object.keys(this.detail).length ? (this.detail as object) : undefined,
        },
      });
    } catch (err) {
      // Never let bookkeeping failure mask the real outcome.
      logger.error({ err, runId: Number(this.id) }, 'failed to write sync_run row');
    }

    const line = {
      runId: Number(this.id),
      kind: this.kind,
      status,
      durationMs,
      ...this.counters,
      ...(errorMessage ? { error: errorMessage } : {}),
    };

    if (status === 'failed') logger.error(line, `sync ${this.kind} failed`);
    else if (status === 'partial') logger.warn(line, `sync ${this.kind} partial`);
    else logger.info(line, `sync ${this.kind} ok`);
  }
}

/** Newest runs, for the admin status page and health endpoint. */
export async function recentRuns(limit = 20, kind?: RunKind) {
  return prisma.syncRun.findMany({
    where: kind ? { kind } : undefined,
    orderBy: { startedAt: 'desc' },
    take: limit,
  });
}

/** Clear out old run rows. Called by the nightly job so the table does not grow without bound. */
export async function pruneRuns(keepDays = 90): Promise<number> {
  const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60_000);
  const { count } = await prisma.syncRun.deleteMany({ where: { startedAt: { lt: cutoff } } });
  if (count > 0) logger.info({ count, keepDays }, 'pruned old sync_runs');
  return count;
}

/**
 * Close out runs that were still 'running' when the process last stopped.
 *
 * A run row is opened before the work starts and closed in a `finally`. That covers a job that
 * throws, but not a process that is killed, put to sleep with the laptop lid, or cut off mid-request
 * and restarted — those leave a row that says 'running' forever. One such row sat open from 13:18
 * until the next morning and made the health endpoint report a sync in progress while nothing was
 * happening at all, which is worse than reporting a failure.
 *
 * Called once at startup: by definition nothing this process started can be in flight yet, so any
 * row still marked running belongs to a previous life and is over whatever happened to it.
 */
export async function reconcileStaleRuns(): Promise<number> {
  const { count } = await prisma.syncRun.updateMany({
    where: { status: 'running' },
    data: {
      status: 'failed',
      finishedAt: new Date(),
      errorMessage: 'interrupted — the service stopped or lost its connection before this run finished',
    },
  });

  if (count > 0) {
    logger.warn({ count }, 'marked interrupted sync runs as failed (the service did not shut down cleanly)');
  }
  return count;
}

/**
 * Settle runs that outlived their deadline, without waiting for a restart.
 *
 * reconcileStaleRuns only runs at startup, and that leaves a real gap. When a job exceeds its
 * deadline the scheduler abandons it and releases the lock — deliberately, because a black-holed
 * socket will not return however politely it is asked — but the abandoned work never reaches its
 * own `finally`, so the sync_runs row it opened stays 'running' for good. Three such rows were
 * sitting open here, the oldest at 73 minutes against a 10-minute deadline, each showing on the
 * admin screen as a sync in progress that had not existed for over an hour.
 *
 * Safe to run WHILE jobs are in flight, which is the whole difference from reconcileStaleRuns —
 * that one settles every open row and is only sound at startup, when nothing of ours can be
 * running yet. Here each kind waits out its own scheduler deadline several times over:
 *
 *   transactions  10-minute deadline  ->  30
 *   employees     15                  ->  45
 *   engine        60                  ->  90
 *   backfill / catchup                ->  240, because those also run from the CLI, where nothing
 *                                          imposes a deadline and a genuine multi-month pull can
 *                                          take hours. Calling one of those failed while it is
 *                                          still downloading would be a worse lie than the phantom.
 *
 * A row this touches therefore cannot belong to work that is still legitimately running under the
 * scheduler.
 */
export async function expireOverdueRuns(): Promise<number> {
  const count = await prisma.$executeRaw`
    update public.sync_runs
       set status = 'failed',
           finished_at = now(),
           error_message = 'abandoned — still open long past the deadline for this job'
     where status = 'running'
       and started_at < now() - (
             case kind
               when 'transactions' then interval '30 minutes'
               when 'employees'    then interval '45 minutes'
               when 'engine'       then interval '90 minutes'
               else                     interval '240 minutes'
             end)
  `;

  if (count > 0) logger.warn({ count }, 'settled sync runs that outlived their deadline');
  return count;
}
