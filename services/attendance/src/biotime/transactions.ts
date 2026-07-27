// Punch transaction retrieval and normalization into rows ready for raw_punches.
import { biotime } from './client';
import { parseBiotimeDateTime, toBiotimeParam } from '../lib/time';
import { logger } from '../lib/logger';
import { asBigInt, asString, type BiotimeTransaction } from './types';

export const TRANSACTIONS_PATH = '/iclock/api/transactions/';

/** A BioTime transaction converted to the shape raw_punches stores. */
export interface NormalizedPunch {
  biotimeId: bigint | null;
  empCode: string;
  punchTime: Date;
  punchState: string | null;
  punchStateLabel: string | null;
  verifyType: string | null;
  terminalSn: string | null;
  terminalAlias: string | null;
  areaAlias: string | null;
  uploadTime: Date | null;
  source: string;
  raw: Record<string, unknown>;
}

export interface FetchTransactionsParams {
  /** Inclusive lower bound (UTC instant), converted to BioTime's local format on the way out. */
  startTime?: Date;
  /** Inclusive upper bound. */
  endTime?: Date;
  empCode?: string;
  terminalSn?: string;
  pageSize?: number;
  maxPages?: number;
  signal?: AbortSignal;
}

function buildParams(p: FetchTransactionsParams): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (p.startTime) params.start_time = toBiotimeParam(p.startTime);
  if (p.endTime) params.end_time = toBiotimeParam(p.endTime);
  if (p.empCode) params.emp_code = p.empCode;
  if (p.terminalSn) params.terminal_sn = p.terminalSn;
  // Cursor advancement assumes oldest→newest; never rely on the server's default order.
  // Servers without OrderingFilter simply ignore the param.
  params.ordering = 'punch_time';
  return params;
}

/**
 * Convert one raw record. Returns null for anything unusable, which is logged and counted rather
 * than thrown: one malformed row out of a 500-row page must not abort the whole batch.
 */
export function normalizeTransaction(
  record: BiotimeTransaction,
  source = 'biotime'
): NormalizedPunch | null {
  const empCode = asString(record.emp_code);
  if (!empCode) return null;

  const punchTime = parseBiotimeDateTime(record.punch_time);
  if (!punchTime) return null;

  return {
    biotimeId: asBigInt(record.id),
    empCode,
    punchTime,
    punchState: asString(record.punch_state),
    punchStateLabel: asString(record.punch_state_display),
    verifyType: asString(record.verify_type_display) ?? asString(record.verify_type),
    terminalSn: asString(record.terminal_sn),
    terminalAlias: asString(record.terminal_alias),
    areaAlias: asString(record.area_alias),
    uploadTime: parseBiotimeDateTime(record.upload_time),
    source,
    raw: record as unknown as Record<string, unknown>,
  };
}

export interface NormalizedBatch {
  punches: NormalizedPunch[];
  received: number;
  malformed: number;
}

/** Stream transaction pages, already normalized. */
export async function* streamTransactions(
  params: FetchTransactionsParams = {},
  source = 'biotime'
): AsyncGenerator<NormalizedBatch, void, undefined> {
  const query = buildParams(params);

  logger.debug({ query }, 'fetching BioTime transactions');

  for await (const page of biotime.paginate<BiotimeTransaction>(TRANSACTIONS_PATH, query, {
    pageSize: params.pageSize,
    maxPages: params.maxPages,
    signal: params.signal,
    onPage: ({ page: n, received, total }) =>
      logger.debug({ page: n, received, total }, 'transaction page'),
  })) {
    const punches: NormalizedPunch[] = [];
    let malformed = 0;

    for (const record of page) {
      const punch = normalizeTransaction(record, source);
      if (punch) {
        punches.push(punch);
      } else {
        malformed += 1;
        logger.warn({ record }, 'skipping unparseable BioTime transaction');
      }
    }

    yield { punches, received: page.length, malformed };
  }
}

/** Small helper for the doctor script: the most recent N transactions, newest first. */
export async function fetchRecentTransactions(limit = 5): Promise<BiotimeTransaction[]> {
  const rows = await biotime.getAll<BiotimeTransaction>(
    TRANSACTIONS_PATH,
    // Explicitly newest-first: the doctor's future-timestamp check inspects rows[0], and without
    // ordering the server's default may hand back the OLDEST punch instead.
    { ordering: '-punch_time' },
    { pageSize: limit, maxPages: 1 }
  );
  return rows.slice(0, limit);
}
