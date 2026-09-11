import { beforeEach, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { NormalizedBatch, NormalizedPunch } from '../biotime/transactions';

let batches: NormalizedBatch[] = [];
let saved: unknown[] = [];
let queued: unknown[][] = [];
let finished: string[] = [];
let advanced = 0;
let failures = 0;
let mapFailure = false;
let queueFailure = false;
let afterInsert: (() => void) | undefined;
let fetchedParams: Record<string, unknown> | undefined;
mock.module(require.resolve('../config/env'), { namedExports: { env: {
  APP_TIMEZONE: 'Asia/Kolkata', BIOTIME_TIMEZONE: 'Asia/Kolkata', SYNC_MAX_PAGES_PER_RUN: 40,
} } });
mock.module(require.resolve('../lib/logger'), { namedExports: {
  logger: { debug() {}, info() {}, warn() {}, error() {} },
} });
mock.module(require.resolve('../lib/db'), { namedExports: { prisma: {
  biotimeEmployee: { findMany: async () => {
    if (mapFailure) throw new Error('employee map unavailable');
    return [{ empCode: '101', employeeId: 'employee-1' }];
  } },
  rawPunch: { createMany: async ({ data }: { data: unknown[] }) => {
    saved.push(...data);
    afterInsert?.();
    return { count: data.length };
  } },
  device: { upsert: async () => {} },
} } });
mock.module(require.resolve('../biotime/transactions'), { namedExports: {
  streamTransactions: async function* (params: Record<string, unknown>) {
    fetchedParams = params;
    for (const batch of batches) yield batch;
  },
} });
mock.module(require.resolve('./cursor'), { namedExports: {
  getCursor: async () => ({ lastPunchTime: new Date('2026-09-10T00:00:00Z'), lastTransactionId: 100n }),
  computeStartTime: () => new Date('2026-09-09T23:55:00Z'),
  markPoll: async () => {},
  markSuccess: async () => { advanced++; },
  advanceCursor: async () => { advanced++; },
  recordFailure: async () => { failures++; return failures; },
} });
mock.module(require.resolve('../engine/recompute'), { namedExports: {
  enqueueRecompute: async (...args: unknown[]) => {
    if (queueFailure) throw new Error('recompute queue unavailable');
    queued.push(args);
  },
} });
mock.module(require.resolve('./runLog'), { namedExports: { SyncRun: {
  start: async () => ({
    counters: { pagesFetched: 0, recordsFetched: 0, recordsInserted: 0, recordsSkipped: 0, unmatchedCodes: 0 },
    addDetail() {},
    finish: async (status: string) => { finished.push(status); },
  }),
} } });
const { runTransactionSync } = require('./syncTransactions') as typeof import('./syncTransactions');

function punch(timestamp: string): NormalizedPunch {
  return {
    biotimeId: 101n, empCode: '101', punchTime: new Date(timestamp), punchState: null,
    punchStateLabel: null, verifyType: null, terminalSn: null, terminalAlias: null,
    areaAlias: null, uploadTime: null, source: 'biotime', raw: {},
  };
}
beforeEach(() => {
  batches = [{ punches: [punch('2026-09-01T00:30:00Z')], received: 1, malformed: 0 }];
  saved = []; queued = []; finished = []; advanced = 0; failures = 0;
  mapFailure = false; queueFailure = false; afterInsert = undefined; fetchedParams = undefined;
});

for (const kind of ['transactions', 'catchup', 'backfill'] as const) {
  test(`${kind} queues a late night-shift exit for its starting day and calendar day`, async () => {
    const result = await runTransactionSync({ kind });
    assert.deepEqual(result, { inserted: 1, fetched: 1, skipped: 0, unmatched: 0 });
    assert.equal(saved.length, 1);
    assert.deepEqual(queued.map((args) => args.slice(0, 3)), [['employee-1', '2026-08-31', '2026-09-01']]);
    assert.deepEqual(finished, ['success']);
    assert.equal(advanced, kind === 'transactions' ? 1 : 0);
  });
}

test('queue failure preserves the cursor so saved punches can be retried and derived', async () => {
  queueFailure = true;
  await assert.rejects(runTransactionSync(), /recompute queue unavailable/);
  assert.equal(saved.length, 1, 'raw punch remains durable even when downstream queue is unavailable');
  assert.equal(advanced, 0);
  assert.equal(failures, 1);
  assert.deepEqual(finished, ['failed']);
});

test('failure loading the employee map settles the run and records the failure', async () => {
  mapFailure = true;
  await assert.rejects(runTransactionSync(), /employee map unavailable/);
  assert.deepEqual(finished, ['failed']);
  assert.equal(failures, 1);
  assert.equal(advanced, 0);
});

test('aborted database writes cannot lead to a successful cursor commit', async () => {
  const controller = new AbortController();
  afterInsert = () => controller.abort();
  await assert.rejects(runTransactionSync({ signal: controller.signal }), /abort/i);
  assert.equal(advanced, 0);
  assert.deepEqual(finished, ['failed']);
});

test('a mixed malformed page stores good punches and refuses to skip past the bad record', async () => {
  batches[0]!.received = 2;
  batches[0]!.malformed = 1;
  await assert.rejects(runTransactionSync(), /malformed|unparseable/i);
  assert.equal(saved.length, 1);
  assert.equal(advanced, 0);
  assert.deepEqual(finished, ['failed']);
});

test('a transaction scan uses a fixed upper bound across all pages', async () => {
  const before = Date.now();
  await runTransactionSync();
  const bound = fetchedParams?.endTime;
  assert.ok(bound instanceof Date);
  assert.ok(bound.getTime() >= before && bound.getTime() <= Date.now());
});

test('dates are grouped per employee to bound the number of queue calls', async () => {
  batches = [{ punches: [punch('2026-09-01T00:30:00Z'), punch('2026-09-03T00:30:00Z')], received: 2, malformed: 0 }];
  await runTransactionSync({ kind: 'backfill' });
  assert.deepEqual(queued.map((args) => args.slice(0, 3)), [['employee-1', '2026-08-31', '2026-09-03']]);
});
