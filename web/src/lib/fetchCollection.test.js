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
  assert.equal(offsets[1], 97);
  assert.equal(offsets.at(-1), 1275);
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
