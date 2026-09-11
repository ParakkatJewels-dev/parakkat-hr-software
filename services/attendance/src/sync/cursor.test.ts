import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
const initial = {
  key: 'transactions', lastPunchTime: new Date('2026-09-01T00:00:00Z'), lastTransactionId: 1n,
  lastSuccessAt: null, lastError: null, consecutiveFailures: 0,
};
let stored = { ...initial };
let reads = 0;
let release!: () => void;
const bothRead = new Promise<void>((resolve) => { release = resolve; });
mock.module(require.resolve('../config/env'), { namedExports: { env: {} } });
mock.module(require.resolve('../lib/logger'), { namedExports: {
  logger: { debug() {}, info() {}, warn() {}, error() {} },
} });
mock.module(require.resolve('../lib/db'), { namedExports: { prisma: {
  syncState: {
    upsert: async () => {
      // Both callers read the same original watermark before either gets to write.
      const snapshot = { ...stored };
      reads++;
      if (reads === 2) release();
      await bothRead;
      return snapshot;
    },
    update: async ({ data }: { data: typeof initial }) => {
      // Force the older result to complete second, reproducing the read/modify/write race.
      if (data.lastTransactionId === 2n) await new Promise((resolve) => setImmediate(resolve));
      stored = { ...stored, ...data };
    },
  },
  $executeRaw: async (sql: TemplateStringsArray, ...values: unknown[]) => {
    assert.match(sql.join('?'), /greatest\(last_punch_time/);
    assert.match(sql.join('?'), /greatest\(last_transaction_id/);
    const timestamp = values[0] as Date;
    const id = values[1] as bigint;
    if (id === 2n) await new Promise((resolve) => setImmediate(resolve));
    stored.lastPunchTime = timestamp > stored.lastPunchTime ? timestamp : stored.lastPunchTime;
    stored.lastTransactionId = id > stored.lastTransactionId ? id : stored.lastTransactionId;
  },
} } });
const { advanceCursor } = require('./cursor') as typeof import('./cursor');

test('a stale overlapping sync cannot rewind a newer committed cursor', async () => {
  await Promise.all([
    advanceCursor('transactions', { lastPunchTime: new Date('2026-09-02T00:00:00Z'), lastTransactionId: 2n }),
    advanceCursor('transactions', { lastPunchTime: new Date('2026-09-03T00:00:00Z'), lastTransactionId: 3n }),
  ]);
  assert.equal(stored.lastPunchTime.toISOString(), '2026-09-03T00:00:00.000Z');
  assert.equal(stored.lastTransactionId, 3n);
});
