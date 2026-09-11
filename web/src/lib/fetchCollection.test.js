import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchCollection } from './fetchCollection.js';

test('complete rosters load across a server cap smaller than the requested page size', async () => {
  const input = Array.from({ length: 1275 }, (_, i) => ({ id: i + 1 }));
  const offsets = [];
  const rows = await fetchCollection(() => ({ range: async (from, to) => {
    offsets.push(from); return { data: input.slice(from, Math.min(to + 1, from + 97)) };
  } }));
  assert.deepEqual(rows, input);
  assert.equal(offsets[1], 96, 'the previous boundary is included in the next request');
  assert.ok(offsets.includes(1275), 'the end is verified even under a one-row response cap');
});
test('empty lists return no rows and subsequent-page errors never return a partial success', async () => {
  assert.deepEqual(await fetchCollection(() => ({ range: async () => ({ data: [] }) })), []);
  let call = 0;
  await assert.rejects(fetchCollection(() => ({ range: async () => ++call === 1
    ? { data: [{ id: 1 }] } : { error: new Error('Access changed') } })), /Access changed/);
});
test('repeated pages and malformed responses fail instead of looping or silently truncating', async () => {
  await assert.rejects(fetchCollection(() => ({ range: async () => ({ data: [{ id: 1 }] }) })), /list changed/);
  await assert.rejects(fetchCollection(() => ({ range: async () => ({ data: null }) })), /complete list/);
});

test('a deletion before the next offset fails instead of silently skipping an unseen employee', async () => {
  const input = Array.from({ length: 6 }, (_, i) => ({ id: i + 1 }));
  let calls = 0;
  await assert.rejects(fetchCollection(() => ({ range: async (from, to) => {
    if (++calls === 2) input.shift();
    return { data: input.slice(from, Math.min(to + 1, from + 2)) };
  } })), /list changed/);
});

test('one-row requested pages and one-row server caps finish with every row exactly once', async () => {
  const input = Array.from({ length: 7 }, (_, i) => ({ id: i + 1 }));
  for (const cap of [1, 2, 97]) {
    for (const pageSize of [1, 2, 500]) {
      let calls = 0;
      const actual = await fetchCollection(() => ({ range: async (from, to) => {
        assert.ok(++calls < 40, 'paging made no progress');
        return { data: input.slice(from, Math.min(to + 1, from + cap)) };
      } }), { pageSize });
      assert.deepEqual(actual, input, `cap=${cap}, requested=${pageSize}`);
    }
  }
});

test('a moving boundary during a one-row-cap continuation is detected', async () => {
  const input = [{ id: 1 }, { id: 2 }, { id: 3 }];
  let calls = 0;
  await assert.rejects(fetchCollection(() => ({ range: async (from) => {
    if (++calls === 3) input.shift();
    return { data: input.slice(from, from + 1) };
  } })), /list changed/);
});
