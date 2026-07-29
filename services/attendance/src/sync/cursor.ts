// The resumable sync cursor (public.sync_state).
//
// Two values are tracked per sync kind and they answer different questions:
//   last_punch_time     — the high-water mark used to build the next start_time query
//   last_transaction_id — the highest BioTime id seen, for diagnostics and gap detection
//
// The cursor advances only after a run completes successfully. Combined with the overlap window
// and the (emp_code, punch_time) unique constraint, that gives at-least-once delivery with
// exactly-once storage: a crash mid-run re-reads some punches and writes none of them twice.
import { prisma } from '../lib/db';
import { logger } from '../lib/logger';
import { env } from '../config/env';

export type SyncKey = 'transactions' | 'employees' | 'devices';

export interface Cursor {
  key: string;
  lastTransactionId: bigint | null;
  lastPunchTime: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export async function getCursor(key: SyncKey): Promise<Cursor> {
  const row = await prisma.syncState.upsert({
    where: { key },
    update: {},
    create: { key },
  });

  return {
    key: row.key,
    lastTransactionId: row.lastTransactionId,
    lastPunchTime: row.lastPunchTime,
    lastSuccessAt: row.lastSuccessAt,
    lastError: row.lastError,
    consecutiveFailures: row.consecutiveFailures,
  };
}

/**
 * Where the next incremental pull should start.
 *
 * With a cursor: the high-water mark minus the overlap window. The overlap is what stops a punch
 * that shares its second with the last batch's newest record from falling through the gap between
 * two runs — BioTime's start_time filter is inclusive, but ordering within the same second is not
 * guaranteed, so we deliberately re-read a few minutes and let the database discard the repeats.
 *
 * Without a cursor (first ever run): INITIAL_SYNC_LOOKBACK_DAYS back.
 */
export function computeStartTime(cursor: Cursor): Date {
  if (cursor.lastPunchTime) {
    return new Date(cursor.lastPunchTime.getTime() - env.SYNC_OVERLAP_MINUTES * 60_000);
  }
  return new Date(Date.now() - env.INITIAL_SYNC_LOOKBACK_DAYS * 24 * 60 * 60_000);
}

export async function advanceCursor(
  key: SyncKey,
  next: { lastPunchTime?: Date | null; lastTransactionId?: bigint | null }
): Promise<void> {
  const current = await getCursor(key);

  // Never move the watermark backwards. A backfill of last March must not reset the live cursor
  // to March and cause the poller to re-read four months of punches.
  const lastPunchTime =
    next.lastPunchTime && (!current.lastPunchTime || next.lastPunchTime > current.lastPunchTime)
      ? next.lastPunchTime
      : current.lastPunchTime;

  const lastTransactionId =
    next.lastTransactionId !== null &&
    next.lastTransactionId !== undefined &&
    (current.lastTransactionId === null || next.lastTransactionId > current.lastTransactionId)
      ? next.lastTransactionId
      : current.lastTransactionId;

  await prisma.syncState.update({
    where: { key },
    data: {
      lastPunchTime,
      lastTransactionId,
      lastSuccessAt: new Date(),
      lastError: null,
      consecutiveFailures: 0,
      updatedAt: new Date(),
    },
  });

  logger.debug({ key, lastPunchTime, lastTransactionId }, 'cursor advanced');
}

/** Mark a successful run that found nothing new — clears the failure streak without moving the mark. */
export async function markSuccess(key: SyncKey): Promise<void> {
  // upsert, not update: on a partially-seeded schema the row may not exist yet, and failing here
  // would mask the real outcome of the run.
  await prisma.syncState.upsert({
    where: { key },
    create: { key, lastSuccessAt: new Date(), consecutiveFailures: 0 },
    update: { lastSuccessAt: new Date(), lastError: null, consecutiveFailures: 0, updatedAt: new Date() },
  });
}

export async function recordFailure(key: SyncKey, error: unknown): Promise<number> {
  const message = error instanceof Error ? error.message : String(error);
  const row = await prisma.syncState.upsert({
    where: { key },
    create: { key, lastError: message.slice(0, 2_000), consecutiveFailures: 1 },
    update: {
      lastError: message.slice(0, 2_000),
      consecutiveFailures: { increment: 1 },
      updatedAt: new Date(),
    },
  });
  return row.consecutiveFailures;
}

/** Rewind the cursor, e.g. to force a re-pull. Deliberately explicit — only scripts call this. */
export async function resetCursor(key: SyncKey, to: Date | null = null): Promise<void> {
  await prisma.syncState.update({
    where: { key },
    data: { lastPunchTime: to, lastTransactionId: null, updatedAt: new Date() },
  });
  logger.warn({ key, to }, 'cursor reset');
}

/**
 * Record that a sync was ATTEMPTED, whatever came of it.
 *
 * The liveness signal, and deliberately separate from the two next to it:
 *
 *   last_poll_at     every attempt          -> is the SERVICE running?
 *   last_success_at  the pull worked        -> is EASY TIME PRO answering?
 *   last_punch_time  punches came back      -> is the MACHINE delivering?
 *
 * last_success_at cannot do this job, which is why this exists. It stops the moment Easy Time Pro
 * stops answering — and at that moment the service is still running perfectly well and still needs
 * to be reported as running, so that somebody goes and looks at Easy Time Pro rather than at the
 * laptop. Telling those two apart is the whole point of the three-link status.
 *
 * Best-effort: a heartbeat that fails must never fail the sync it was reporting on.
 */
export async function markPoll(key: SyncKey): Promise<void> {
  try {
    await prisma.syncState.upsert({
      where: { key },
      create: { key, lastPollAt: new Date() },
      update: { lastPollAt: new Date() },
    });
  } catch (err) {
    logger.debug({ key, err: err instanceof Error ? err.message : String(err) }, 'could not record the poll heartbeat');
  }
}
