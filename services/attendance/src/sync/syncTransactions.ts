// The punch sync worker — the heart of Phase 1.
//
// Contract:
//   - a punch on any terminal reaches raw_punches within one poll interval
//   - BioTime restarting, or the network dropping mid-page, loses nothing and duplicates nothing
//   - the cursor advances only after a run completes, so a crash re-reads rather than skips
//
// Duplicate safety comes from the database, not from this code: (emp_code, punch_time) is unique,
// and every insert is ON CONFLICT DO NOTHING. That means the overlap window, a backfill covering
// already-synced dates, and two workers briefly running at once are all harmless.
import { prisma } from '../lib/db';
import { logger } from '../lib/logger';
import { env } from '../config/env';
import { streamTransactions, type NormalizedPunch } from '../biotime/transactions';
import { advanceCursor, computeStartTime, getCursor, markSuccess, recordFailure } from './cursor';
import { SyncRun, type RunKind } from './runLog';

/** Insert chunk size. Large enough to be efficient, small enough to keep statements sane. */
const INSERT_CHUNK = 500;

/** emp_code -> employee id, for stamping punches at ingest. Rebuilt at the start of every run. */
async function loadEmployeeMap(): Promise<Map<string, string>> {
  const rows = await prisma.biotimeEmployee.findMany({
    where: { employeeId: { not: null } },
    select: { empCode: true, employeeId: true },
  });

  const map = new Map<string, string>();
  for (const r of rows) {
    if (r.employeeId) map.set(r.empCode, r.employeeId);
  }
  return map;
}

/**
 * Make sure every terminal we saw a punch from exists in `devices`.
 *
 * Lazy creation matters: a terminal added in BioTime this morning starts sending punches
 * immediately, and we must not depend on the daily roster sync having run first. HR's own
 * entity/branch mapping on the row is never touched here.
 */
async function upsertDevicesFromPunches(punches: NormalizedPunch[]): Promise<void> {
  const bySerial = new Map<string, { alias: string | null; area: string | null; lastPunch: Date }>();

  for (const p of punches) {
    if (!p.terminalSn) continue;
    const existing = bySerial.get(p.terminalSn);
    if (!existing || p.punchTime > existing.lastPunch) {
      bySerial.set(p.terminalSn, {
        alias: p.terminalAlias ?? existing?.alias ?? null,
        area: p.areaAlias ?? existing?.area ?? null,
        lastPunch: p.punchTime,
      });
    }
  }

  for (const [serialNumber, info] of bySerial) {
    try {
      await prisma.device.upsert({
        where: { serialNumber },
        create: {
          serialNumber,
          alias: info.alias,
          areaName: info.area,
          lastPunchAt: info.lastPunch,
        },
        update: {
          // Only device-reported facts. entityId / branchId are HR's to set.
          ...(info.alias ? { alias: info.alias } : {}),
          ...(info.area ? { areaName: info.area } : {}),
          lastPunchAt: info.lastPunch,
          updatedAt: new Date(),
        },
      });
    } catch (err) {
      // A device row failing must never cost us the punches themselves.
      logger.warn({ err, serialNumber }, 'could not upsert device from punch');
    }
  }
}

export interface IngestResult {
  attempted: number;
  inserted: number;
  skipped: number;
  unmatched: number;
  maxPunchTime: Date | null;
  maxBiotimeId: bigint | null;
  unmatchedCodes: Set<string>;
}

/** Write one batch of normalized punches. Idempotent by construction. */
export async function ingestPunches(
  punches: NormalizedPunch[],
  employeeMap: Map<string, string>
): Promise<IngestResult> {
  const result: IngestResult = {
    attempted: punches.length,
    inserted: 0,
    skipped: 0,
    unmatched: 0,
    maxPunchTime: null,
    maxBiotimeId: null,
    unmatchedCodes: new Set(),
  };

  if (punches.length === 0) return result;

  const rows = punches.map((p) => {
    const employeeId = employeeMap.get(p.empCode) ?? null;

    if (!employeeId) {
      result.unmatched += 1;
      result.unmatchedCodes.add(p.empCode);
    }
    if (!result.maxPunchTime || p.punchTime > result.maxPunchTime) {
      result.maxPunchTime = p.punchTime;
    }
    if (p.biotimeId !== null && (result.maxBiotimeId === null || p.biotimeId > result.maxBiotimeId)) {
      result.maxBiotimeId = p.biotimeId;
    }

    return {
      biotimeId: p.biotimeId,
      empCode: p.empCode,
      employeeId,
      punchTime: p.punchTime,
      punchState: p.punchState,
      punchStateLabel: p.punchStateLabel,
      verifyType: p.verifyType,
      terminalSn: p.terminalSn,
      terminalAlias: p.terminalAlias,
      areaAlias: p.areaAlias,
      uploadTime: p.uploadTime,
      source: p.source,
      raw: p.raw as object,
    };
  });

  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    const { count } = await prisma.rawPunch.createMany({ data: chunk, skipDuplicates: true });
    result.inserted += count;
  }

  result.skipped = result.attempted - result.inserted;

  await upsertDevicesFromPunches(punches);

  return result;
}

export interface SyncOptions {
  startTime?: Date;
  endTime?: Date;
  maxPages?: number;
  signal?: AbortSignal;
  /** Labels the sync_runs row. */
  kind?: RunKind;
  /** Labels raw_punches.source. */
  source?: string;
  /** Backfills must not drag the live cursor backwards. */
  advanceCursorAfter?: boolean;
}

/**
 * Pull transactions in a window and store them.
 * Shared by the incremental poll, the nightly catch-up and the backfill script.
 */
export async function runTransactionSync(opts: SyncOptions = {}): Promise<{
  inserted: number;
  fetched: number;
  skipped: number;
  unmatched: number;
}> {
  const kind: RunKind = opts.kind ?? 'transactions';
  const advance = opts.advanceCursorAfter ?? kind === 'transactions';

  const cursor = await getCursor('transactions');
  const startTime = opts.startTime ?? computeStartTime(cursor);

  const run = await SyncRun.start(kind, {
    lastPunchTime: cursor.lastPunchTime,
    lastTransactionId: cursor.lastTransactionId ? Number(cursor.lastTransactionId) : null,
    startTime,
    endTime: opts.endTime ?? null,
  });

  const employeeMap = await loadEmployeeMap();
  const allUnmatched = new Set<string>();

  let maxPunchTime: Date | null = null;
  let maxBiotimeId: bigint | null = null;

  try {
    for await (const batch of streamTransactions(
      {
        startTime,
        endTime: opts.endTime,
        maxPages: opts.maxPages ?? env.SYNC_MAX_PAGES_PER_RUN,
        signal: opts.signal,
      },
      opts.source ?? 'biotime'
    )) {
      run.counters.pagesFetched += 1;
      run.counters.recordsFetched += batch.received;

      const ingested = await ingestPunches(batch.punches, employeeMap);

      run.counters.recordsInserted += ingested.inserted;
      run.counters.recordsSkipped += ingested.skipped;
      for (const code of ingested.unmatchedCodes) allUnmatched.add(code);

      if (ingested.maxPunchTime && (!maxPunchTime || ingested.maxPunchTime > maxPunchTime)) {
        maxPunchTime = ingested.maxPunchTime;
      }
      if (ingested.maxBiotimeId !== null && (maxBiotimeId === null || ingested.maxBiotimeId > maxBiotimeId)) {
        maxBiotimeId = ingested.maxBiotimeId;
      }
    }

    run.counters.unmatchedCodes = allUnmatched.size;

    if (allUnmatched.size > 0) {
      run.addDetail({ unmatchedCodes: [...allUnmatched].slice(0, 50) });
      logger.warn(
        { count: allUnmatched.size, sample: [...allUnmatched].slice(0, 10) },
        'punches stored for emp_codes with no linked employee — map them in HR > Devices'
      );
    }

    // Only now, with every page written, does the watermark move.
    if (advance && maxPunchTime) {
      await advanceCursor('transactions', { lastPunchTime: maxPunchTime, lastTransactionId: maxBiotimeId });
    } else if (advance) {
      await markSuccess('transactions');
    }

    await run.finish('success', {
      cursorAfter: {
        lastPunchTime: maxPunchTime,
        lastTransactionId: maxBiotimeId ? Number(maxBiotimeId) : null,
        advanced: advance,
      },
    });

    return {
      inserted: run.counters.recordsInserted,
      fetched: run.counters.recordsFetched,
      skipped: run.counters.recordsSkipped,
      unmatched: allUnmatched.size,
    };
  } catch (err) {
    // Whatever was already written stays written — that is safe, because the cursor did not move
    // and the next run re-reads the same window and discards the duplicates.
    if (advance) {
      const failures = await recordFailure('transactions', err);
      if (failures >= 5) {
        logger.error({ failures }, 'transaction sync has failed repeatedly — check BioTime connectivity');
      }
    }
    await run.finish('failed', { error: err });
    throw err;
  }
}

/** The scheduled 1–2 minute poll. */
export async function syncTransactions(signal?: AbortSignal) {
  return runTransactionSync({ kind: 'transactions', signal, advanceCursorAfter: true });
}

/**
 * Nightly re-scan of the trailing window.
 *
 * A terminal that lost its network connection stores punches locally and uploads them when it
 * recovers — with their original punch_time, which is already behind the cursor. The incremental
 * poll structurally cannot see those. This is what catches them.
 */
export async function catchUpTransactions(days = env.SYNC_CATCHUP_DAYS, signal?: AbortSignal) {
  if (days <= 0) return { inserted: 0, fetched: 0, skipped: 0, unmatched: 0 };

  const startTime = new Date(Date.now() - days * 24 * 60 * 60_000);
  logger.info({ days, startTime }, 'catch-up scan for late-uploaded punches');

  return runTransactionSync({
    kind: 'catchup',
    startTime,
    signal,
    // A catch-up looks backwards; it must not rewind the live cursor.
    advanceCursorAfter: false,
    maxPages: 10_000,
  });
}
