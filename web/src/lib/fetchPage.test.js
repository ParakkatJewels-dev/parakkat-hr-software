import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPage } from './fetchPage.js';

const records = (count) => Array.from({ length: count }, (_, id) => ({ id, created_at: '2026-09-01' }));
function cappedQuery(rows, { cap = Infinity, beforeRead, response } = {}) {
  const calls = [];
  return {
    calls,
    makeQuery: () => ({ range: async (from, to) => {
      calls.push([from, to]);
      beforeRead?.(calls.length, rows);
      return response?.(calls.length, from, to) ?? {
        data: rows.slice(from, Math.min(to + 1, from + cap)), count: rows.length,
      };
    } }),
  };
}

test('normal, final, empty and out-of-range pages preserve exact counts', async () => {
  const rows = records(53);
  for (const [page, start, end] of [[1, 0, 25], [2, 25, 50], [3, 50, 53], [4, 75, 75]]) {
    const query = cappedQuery(rows);
    assert.deepEqual(await fetchPage(query.makeQuery, { page }), { rows: rows.slice(start, end), count: 53 });
    assert.deepEqual(query.calls, [[(page - 1) * 25, page * 25 - 1]]);
  }
  assert.deepEqual(await fetchPage(cappedQuery([]).makeQuery), { rows: [], count: 0 });
});

test('small API caps refill every requested row, retaining caller order despite timestamp ties', async () => {
  const rows = records(53).reverse();
  for (const cap of [1, 2, 7]) {
    for (const page of [1, 2, 3]) {
      const query = cappedQuery(rows, { cap });
      const result = await fetchPage(query.makeQuery, { page, pageSize: 25 });
      assert.deepEqual(result, { rows: rows.slice((page - 1) * 25, page * 25), count: 53 });
      assert.equal(new Set(result.rows.map(row => row.id)).size, result.rows.length);
      assert.equal(query.calls.length > 1, result.rows.length > cap);
      assert.ok(query.calls.every(([from, to]) => from >= (page - 1) * 25 && to < page * 25));
    }
  }
});

test('deletions and insertions during a capped refill reject changed exact counts', async () => {
  for (const mutate of [rows => rows.shift(), rows => rows.unshift({ id: 'new' })]) {
    const query = cappedQuery(records(10), { cap: 2, beforeRead: (call, rows) => { if (call === 2) mutate(rows); } });
    await assert.rejects(fetchPage(query.makeQuery), /list changed/);
  }
});

test('moving the refill boundary is detected even when the total count stays unchanged', async () => {
  const query = cappedQuery(records(10), { cap: 2, beforeRead: (call, rows) => {
    if (call === 2) rows.push(rows.shift());
  } });
  await assert.rejects(fetchPage(query.makeQuery), /list changed/);
});

test('a cap-one continuation rechecks the boundary after its separate read', async () => {
  const query = cappedQuery(records(10), { cap: 1, beforeRead: (call, rows) => {
    if (call === 3) rows.push(rows.shift());
  } });
  await assert.rejects(fetchPage(query.makeQuery), /list changed/);
  assert.deepEqual(query.calls, [[0, 24], [0, 24], [1, 24], [0, 0]]);
});

test('query errors and invalid or unexpectedly incomplete page responses cannot become successful partial results', async () => {
  const query = cappedQuery(records(10), { cap: 2, response: call => call === 2 ? { error: new Error('Read denied') } : null });
  await assert.rejects(fetchPage(query.makeQuery), /Read denied/);
  for (const result of [{ data: null, count: 10 }, { data: [], count: null }, { data: [], count: 1 }]) {
    await assert.rejects(fetchPage(cappedQuery([], { response: () => result }).makeQuery), /refresh/i);
  }
  const missingContinuation = cappedQuery(records(10), { cap: 2, response: call => call > 1 ? { data: [], count: 10 } : null });
  await assert.rejects(fetchPage(missingContinuation.makeQuery), /list changed/);
});

test('duplicate or missing row IDs are rejected without treating timestamp ties as duplicates', async () => {
  for (const rows of [[{ id: 'same' }, { id: 'same' }], [{ created_at: '2026-09-01' }]]) {
    await assert.rejects(fetchPage(cappedQuery(rows).makeQuery), /list changed/);
  }
});

test('invalid page numbers fall back to the first page and oversized pages stay bounded', async () => {
  const rows = records(300);
  assert.deepEqual((await fetchPage(cappedQuery(rows).makeQuery, { page: Infinity })).rows, rows.slice(0, 25));
  const query = cappedQuery(rows);
  assert.equal((await fetchPage(query.makeQuery, { pageSize: 1000 })).rows.length, 200);
  assert.deepEqual(query.calls, [[0, 199]]);
});
