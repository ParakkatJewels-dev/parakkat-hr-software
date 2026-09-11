import { before, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthContext } from '../api/auth';

const actor: AuthContext = { userId: 'requester', email: null, isSuperAdmin: true, permissions: [], employee: null };
let auth: AuthContext | null = actor;
let pending: { id: string; kind: string; params: Record<string, unknown>; requested_by: string | null } | null;
let afterWork: (() => void) | undefined;
const calls: Array<{ name: string; args?: unknown }> = [];
const writes: Array<{ sql: string; values: unknown[] }> = [];
let drain: typeof import('./commands').drainServiceCommands;

before(async () => {
  mock.module(require.resolve('../lib/logger'), { namedExports: { logger: { info() {}, warn() {}, error() {} } } });
  mock.module(require.resolve('../lib/db'), { namedExports: { prisma: {
    $queryRaw: async () => { calls.push({ name: 'claim' }); const row = pending; pending = null; return row ? [row] : []; },
    $executeRaw: async (sql: TemplateStringsArray, ...values: unknown[]) => { writes.push({ sql: sql.join('?'), values }); return 1; },
  } } });
  mock.module(require.resolve('../api/auth'), { namedExports: {
    contextForUserId: async () => auth,
    hasPermission: (context: AuthContext | undefined, permission: string) => Boolean(context?.isSuperAdmin || context?.permissions.some(g => g.permission === permission)),
    resolveVisibleScope: async (context: AuthContext | undefined, permissions: string[]) => ({
      all: Boolean(context?.isSuperAdmin || context?.permissions.some(g => permissions.includes(g.permission) && g.scope_type === 'global')),
      branchIds: [], entityIds: [],
    }),
  } });
  const work = (name: string) => async (args?: unknown) => {
    calls.push({ name, args }); afterWork?.();
    return name === 'backfill' ? { inserted: 7, fetched: 9, skipped: 2, unmatched: 1 } : { rowsWritten: 503 };
  };
  mock.module(require.resolve('../sync/syncTransactions'), { namedExports: { syncTransactions: work('sync'), runTransactionSync: work('backfill') } });
  mock.module(require.resolve('../sync/syncEmployees'), { namedExports: { syncEmployees: work('employees'), refreshSuggestions: work('suggestions') } });
  mock.module(require.resolve('../engine/recompute'), { namedExports: { recompute: work('recompute') } });
  mock.module(require.resolve('../config/env'), { namedExports: { env: { APP_TIMEZONE: 'Asia/Kolkata', BIOTIME_TIMEZONE: 'Asia/Kolkata' } } });
  mock.module(require.resolve('../exports/generate'), { namedExports: {
    generateExport: async (args: unknown) => { calls.push({ name: 'export', args }); afterWork?.(); return {
      filename: 'fixture.xlsx', workbook: { xlsx: { writeBuffer: async () => Buffer.from([0x50, 0x4b, 0, 255]) } },
    }; },
  } });
  ({ drainServiceCommands: drain } = require('./commands') as typeof import('./commands'));
});
beforeEach(() => { auth = actor; pending = null; calls.length = 0; writes.length = 0; afterWork = undefined; });
const enqueue = (kind: string, params: Record<string, unknown> = {}) => { pending = { id: '00000000-0000-4000-8000-000000000001', kind, params, requested_by: 'requester' }; };
const failure = () => assert.ok(writes.some(w => w.sql.includes("status = 'failed'")), 'command must be failed');
const noWork = () => assert.deepEqual(calls.filter(c => c.name !== 'claim'), [], 'denied/invalid commands must not start work');

test('a requester whose authority was revoked cannot run queued global work', async () => {
  for (const kind of ['sync_transactions', 'sync_employees', 'refresh_suggestions', 'recompute', 'backfill']) {
    auth = null; calls.length = 0; writes.length = 0;
    enqueue(kind, { from: '2026-07-01', to: '2026-07-02' });
    await drain(); failure(); noWork();
  }
});
test('entity-scoped device authority cannot run organisation-wide queued operations', async () => {
  auth = { ...actor, isSuperAdmin: false, permissions: [{ permission: 'device.manage', scope_type: 'entity', scope_id: 'company-a' }] };
  enqueue('backfill', { from: '2026-07-01', to: '2026-07-02' });
  await drain(); failure(); noWork();
});
test('malformed dates and explicit empty employee selections fail before recompute', async () => {
  for (const params of [{ from: '2026-02-30' }, { from: '2026-07-01', employeeIds: [] },
    { from: '2026-07-01', employeeIds: ['not-a-uuid'] }, { from: '2026-07-01', to: 123 }]) {
    calls.length = 0; writes.length = 0; enqueue('recompute', params);
    await drain(); failure(); noWork();
  }
});
test('invalid backfill dates do not reach BioTime', async () => {
  enqueue('backfill', { from: '2026-02-30', to: '2026-03-01' });
  await drain(); failure(); noWork();
});
test('malformed selected branches never widen a queued export', async () => {
  for (const branchIds of [[null], [123], { branch: 'x' }, ['00000000-0000-4000-8000-000000000001', false]]) {
    calls.length = 0; writes.length = 0; enqueue('export_register', { year: 2026, month: 7, branchIds });
    await drain(); failure(); noWork();
  }
});
test('valid branch array/string selections and intentional all-branch selections reach the exporter', async () => {
  const branch = '00000000-0000-4000-8000-000000000001';
  for (const [input, expected] of [[branch, branch], [[branch], branch], [undefined, undefined], [[], undefined]] as const) {
    calls.length = 0; writes.length = 0;
    enqueue('export_register', { year: 2026, month: 7, branchIds: input }); await drain();
    const args = calls.find(c => c.name === 'export')?.args as { branchIds: string | undefined };
    assert.ok(args); assert.equal(args.branchIds, expected);
    assert.equal(writes.some(w => w.sql.includes("status = 'failed'")), false);
  }
});
test('an aborted worker does not claim another command', async () => {
  const abort = new AbortController(); abort.abort(); enqueue('sync_transactions');
  await assert.rejects(drain(abort.signal));
  assert.deepEqual(calls, []); assert.deepEqual(writes, []);
});
test('work finishing after cancellation cannot report successful completion', async () => {
  const abort = new AbortController(); afterWork = () => abort.abort(); enqueue('sync_transactions');
  await drain(abort.signal); failure();
  assert.equal(writes.some(w => w.sql.includes("status = 'done'")), false);
});
test('command completion cannot overwrite an expired or externally settled status', async () => {
  enqueue('sync_transactions'); await drain();
  assert.ok(writes.length > 0);
  for (const write of writes) assert.match(write.sql, /where id = \?::uuid\s+and status = 'running'/);
});
test('valid selected employees and inclusive backfill bounds survive the queue', async () => {
  const employeeIds = ['00000000-0000-4000-8000-000000000501'];
  enqueue('recompute', { from: '2026-07-01', to: '2026-07-02', employeeIds }); await drain();
  assert.deepEqual(calls.find(c => c.name === 'recompute')?.args, { from: '2026-07-01', to: '2026-07-02', employeeIds });
  calls.length = 0; enqueue('backfill', { from: '2026-07-01', to: '2026-07-02' }); await drain();
  const args = calls.find(c => c.name === 'backfill')?.args as { startTime: Date; endTime: Date };
  assert.equal(args.startTime.toISOString(), '2026-06-30T18:30:00.000Z');
  assert.equal(args.endTime.toISOString(), '2026-07-02T18:29:59.999Z');
});
test('month-long queued backfills cover every date exactly once in bounded weekly windows', async () => {
  enqueue('backfill', { from: '2026-07-01', to: '2026-07-31', recompute: true }); await drain();
  const chunks = calls.filter(c => c.name === 'backfill').map(c => c.args as { startTime: Date; endTime: Date; maxPages: number });
  assert.equal(chunks.length, 5);
  assert.equal(chunks[0]?.startTime.toISOString(), '2026-06-30T18:30:00.000Z');
  assert.equal(chunks.at(-1)?.endTime.toISOString(), '2026-07-31T18:29:59.999Z');
  for (let i = 0; i < chunks.length; i++) {
    assert.ok(chunks[i]!.endTime.getTime() - chunks[i]!.startTime.getTime() < 7 * 86_400_000);
    assert.equal(chunks[i]!.maxPages, 10_000);
    if (i) assert.equal(chunks[i]!.startTime.getTime(), chunks[i - 1]!.endTime.getTime() + 1);
  }
  assert.deepEqual(calls.at(-1), { name: 'recompute', args: { from: '2026-07-01', to: '2026-07-31' } });
  assert.deepEqual(JSON.parse(writes.at(-1)!.values[0] as string), { inserted: 35, fetched: 45, skipped: 10, chunks: 5, rowsWritten: 503 });
});
test('cancellation between backfill windows stops remaining pages and final recomputation', async () => {
  const abort = new AbortController(); afterWork = () => abort.abort();
  enqueue('backfill', { from: '2026-07-01', to: '2026-07-31', recompute: true }); await drain(abort.signal);
  assert.equal(calls.filter(c => c.name === 'backfill').length, 1);
  assert.equal(calls.some(c => c.name === 'recompute'), false); failure();
});
test('valid export filters and binary result remain intact', async () => {
  const branchId = '00000000-0000-4000-8000-000000000001';
  enqueue('export_register', { year: 2026, month: 7, branchIds: [branchId], columns: ['employee_code'] }); await drain();
  const args = calls.find(c => c.name === 'export')?.args as { branchIds: string; columns: string[] };
  assert.equal(args.branchIds, branchId); assert.deepEqual(args.columns, ['employee_code']);
  const file = writes.find(w => w.sql.includes('result_file'));
  assert.ok(file); assert.ok(file.values.includes(Buffer.from([0x50, 0x4b, 0, 255]).toString('base64')));
  assert.deepEqual(JSON.parse(file.values[0] as string), { filename: 'fixture.xlsx', bytes: 4 });
});
