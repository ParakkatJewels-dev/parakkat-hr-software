import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppQueryClient, retryQuery, queryRetryDelay } from './queryPolicy.js';

test('permission, validation, throttling and abort errors are never retried', () => {
  for (const error of [{ status: 401 }, { status: 403 }, { status: 404 }, { status: 429 },
    { code: 'PT429' }, { code: '42501' }, { code: '23505' }, { code: 'PGRST116' },
    { name: 'AbortError', message: 'Failed to fetch' }, new Error('The list changed while loading.')]) {
    assert.equal(retryQuery(0, error), false, JSON.stringify(error));
  }
});

test('transient network and server failures have at most two retries with bounded jitter', () => {
  for (const error of [new TypeError('Failed to fetch'), { status: 503 }, { code: 'PT500' },
    { code: '08006' }, { code: '53300' }, { code: '40001' }, { code: 'PGRST003' }]) {
    assert.equal(retryQuery(0, error), true);
    assert.equal(retryQuery(1, error), true);
    assert.equal(retryQuery(2, error), false);
  }
  assert.equal(queryRetryDelay(0, null, () => 0), 1000);
  assert.equal(queryRetryDelay(1, null, () => 0.5), 2250);
  assert.equal(queryRetryDelay(100, null, () => 0.998), 15499);
  assert.equal(queryRetryDelay(0, { retryAfter: 5 }, () => 0), 5000);
  assert.equal(retryQuery(0, { status: 503, retryAfter: 120 }), false);
});

test('fresh cached reads and concurrent identical reads do not hit the database again', async () => {
  const client = createAppQueryClient();
  try {
    let reads = 0, release;
    const options = { queryKey: ['employees'], queryFn: () => { reads++; return new Promise(resolve => { release = resolve; }); } };
    const first = client.fetchQuery(options), second = client.fetchQuery(options);
    assert.equal(reads, 1);
    release([{ id: 'employee' }]);
    assert.deepEqual(await first, await second);
    assert.deepEqual(await client.fetchQuery(options), [{ id: 'employee' }]);
    assert.equal(reads, 1);
    await client.invalidateQueries({ queryKey: ['employees'], refetchType: 'none' });
    const changed = client.fetchQuery(options);
    assert.equal(reads, 2, 'explicit invalidation still bypasses a fresh cache');
    release([{ id: 'updated' }]);
    assert.deepEqual(await changed, [{ id: 'updated' }]);
  } finally { client.clear(); }
});

test('reference and media policies reduce periodic reads without disabling live invalidation', () => {
  const client = createAppQueryClient();
  try {
    const defaults = client.getDefaultOptions();
    assert.equal(defaults.queries.refetchIntervalInBackground, false);
    assert.equal(defaults.mutations.retry, false);
    const org = client.defaultQueryOptions({ queryKey: ['org', 'all'] });
    assert.equal(org.staleTime, 300_000);
    assert.equal(org.refetchInterval, 900_000);
    assert.equal(typeof client.defaultQueryOptions({ queryKey: ['chat-media-url', 'path'] }).refetchInterval, 'function');
    assert.equal(client.defaultQueryOptions({ queryKey: ['message-delivery'], refetchInterval: 30_000 }).refetchInterval, 30_000,
      'live screens retain their shorter safety polls');
  } finally { client.clear(); }
});

test('restored signed URLs refresh at their original deadline rather than one lifetime after remount', async (t) => {
  const now = Date.UTC(2026, 8, 15, 10);
  t.mock.timers.enable({ apis: ['Date'], now });
  const client = createAppQueryClient();
  try {
    for (const [key, age, refreshAt, remaining] of [
      ['chat-media-url', 54 * 60_000, 55 * 60_000, 60_000],
      ['employee-avatars', 7 * 60_000 + 50_000, 8 * 60_000, 10_000],
      ['asset-photos', 7 * 60_000 + 50_000, 8 * 60_000, 10_000],
    ]) {
      const queryKey = [key, 'file'];
      client.setQueryData(queryKey, 'signed-url', { updatedAt: now - age });
      let reads = 0;
      const options = client.defaultQueryOptions({ queryKey, staleTime: refreshAt,
        queryFn: async () => { reads++; return 'renewed-url'; } });
      assert.equal(await client.fetchQuery(options), 'signed-url');
      assert.equal(reads, 0, 'a still-valid restored signature is reused');
      const query = client.getQueryCache().find({ queryKey });
      assert.equal(options.refetchInterval(query), remaining, 'next signing follows the cached timestamp');
    }
    const options = client.defaultQueryOptions({ queryKey: ['chat-media-url', 'failed'] });
    assert.equal(options.refetchInterval({ state: { status: 'error', dataUpdatedAt: now - 3600_000 } }), 60_000,
      'a failed renewal must not become one request every second');
  } finally { client.clear(); }
});
