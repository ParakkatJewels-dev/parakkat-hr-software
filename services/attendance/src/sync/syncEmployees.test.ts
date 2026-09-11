import { beforeEach, test, mock } from 'node:test';
import assert from 'node:assert/strict';
let updates: Array<Record<string, unknown>> = [];
let finished: string[] = [];
let successes = 0;
let failures = 0;
let controller: AbortController | undefined;
let cancelAfterLookup = false;
let existing: Record<string, unknown> | null = null;
let candidates: Array<Record<string, unknown>> = [];
mock.module(require.resolve('../lib/logger'), { namedExports: {
  logger: { debug() {}, info() {}, warn() {}, error() {} },
} });
mock.module(require.resolve('../biotime/employees'), { namedExports: {
  fetchAllEmployees: async () => [{ empCode: '101', fullName: 'Sample Person', raw: {} }],
  fetchAllTerminals: async () => [],
} });
mock.module(require.resolve('../lib/db'), { namedExports: { prisma: {
  $queryRaw: async () => candidates,
  biotimeEmployee: {
    findUnique: async () => { if (cancelAfterLookup) controller?.abort(); return existing; },
    update: async ({ data }: { data: Record<string, unknown> }) => { updates.push(data); },
    create: async ({ data }: { data: Record<string, unknown> }) => { updates.push(data); },
  },
} } });
mock.module(require.resolve('./cursor'), { namedExports: {
  markSuccess: async () => { successes++; },
  recordFailure: async () => { failures++; },
} });
mock.module(require.resolve('./runLog'), { namedExports: { SyncRun: {
  start: async () => ({
    counters: { recordsFetched: 0, recordsInserted: 0, pagesFetched: 0, unmatchedCodes: 0 },
    addDetail() {}, finish: async (status: string) => { finished.push(status); },
  }),
} } });
const { syncEmployees } = require('./syncEmployees') as typeof import('./syncEmployees');
beforeEach(() => {
  updates = []; finished = []; successes = 0; failures = 0; existing = null;
  controller = undefined; cancelAfterLookup = false; candidates = [];
});

test('roster cancellation while reading a mapping prevents the subsequent mutation and success', async () => {
  controller = new AbortController(); cancelAfterLookup = true;
  await assert.rejects(syncEmployees(controller.signal), /abort/i);
  assert.equal(updates.length, 0);
  assert.equal(successes, 0);
  assert.equal(failures, 1);
  assert.deepEqual(finished, ['failed']);
});

for (const linkStatus of ['manual', 'ignored']) {
  test(`a ${linkStatus} mapping survives roster refresh`, async () => {
    existing = { employeeId: linkStatus === 'manual' ? 'person-1' : null, linkStatus };
    await syncEmployees();
    assert.equal(updates.length, 1);
    assert.equal('employeeId' in updates[0]!, false);
    assert.equal('linkStatus' in updates[0]!, false);
    assert.equal(successes, 1);
  });
}

test('duplicate employee codes across entities remain ambiguous with no automatic employee link', async () => {
  candidates = [
    { id: 'person-1', full_name: 'Sample Person', employee_code: '101' },
    { id: 'person-2', full_name: 'Other Person', employee_code: '101' },
  ];
  const result = await syncEmployees();
  assert.equal(result.ambiguous, 1);
  assert.equal(updates[0]?.linkStatus, 'ambiguous');
  assert.equal(updates[0]?.employeeId, null);
});
