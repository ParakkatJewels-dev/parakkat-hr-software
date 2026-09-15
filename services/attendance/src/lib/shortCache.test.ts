import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortCache } from './shortCache';

test('concurrent diagnostics requests share one query and refresh after the short TTL', async () => {
  let now = 1000, reads = 0;
  const cached = shortCache(async () => ++reads, 5000, () => now);
  assert.deepEqual(await Promise.all([cached(), cached(), cached()]), [1, 1, 1]);
  now += 4999; assert.equal(await cached(), 1);
  now++; assert.equal(await cached(), 2);
});

test('a failed diagnostics read is retried and never returned as cached success', async () => {
  let failed = true, reads = 0;
  const cached = shortCache(async () => { reads++; if (failed) throw new Error('fixture failure'); return 'ok'; }, 5000);
  const results = await Promise.allSettled([cached(), cached()]);
  assert.equal(reads, 1);
  assert.ok(results.every(result => result.status === 'rejected'));
  failed = false;
  assert.equal(await cached(), 'ok');
  assert.equal(reads, 2);
});
