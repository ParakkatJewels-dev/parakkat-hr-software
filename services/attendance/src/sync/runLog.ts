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
