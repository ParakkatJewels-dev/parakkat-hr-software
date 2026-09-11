import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

mock.module(require.resolve('../config/env'), { namedExports: {
  env: { BIOTIME_PAGE_SIZE: 500, BIOTIME_AUTH_MODE: 'auto' },
  requireBiotimeConfig: () => { throw new Error('Network credentials are unavailable in this test'); },
} });
mock.module(require.resolve('../lib/logger'), { namedExports: {
  logger: { debug() {}, info() {}, warn() {}, error() {} },
} });
const { BiotimeClient } = require('./client') as typeof import('./client');

function fixture(pages: unknown[]) {
  const client = new BiotimeClient();
  const calls: number[] = [];
  client.get = async <T>(_path: string, params?: Record<string, unknown>): Promise<T> => {
    calls.push(Number(params?.page));
    assert.ok(calls.length <= pages.length, 'pagination requested beyond the fixture');
    return pages[calls.length - 1] as T;
  };
  return { client, calls };
}

test('a truncated page budget fails instead of claiming the entire window was read', async () => {
  const { client, calls } = fixture([{ count: 3, next: '?page=2', data: [{ id: 3 }, { id: 2 }] }]);
  await assert.rejects(client.getAll('/transactions', {}, { pageSize: 2, maxPages: 1 }), /page limit|incomplete/i);
  assert.deepEqual(calls, [1]);
});

test('explicit recent-record sampling may stop at a page budget', async () => {
  const { client } = fixture([{ count: 3, next: '?page=2', data: [{ id: 3 }, { id: 2 }] }]);
  assert.deepEqual(await client.getAll('/transactions', {}, {
    pageSize: 2, maxPages: 1, allowPartial: true,
  }), [{ id: 3 }, { id: 2 }]);
});

test('an abort after yielding a page rejects the unfinished scan', async () => {
  const { client, calls } = fixture([{ count: 2, next: '?page=2', data: [{ id: 1 }] }]);
  const controller = new AbortController();
  const pages = client.paginate('/transactions', {}, { pageSize: 1, signal: controller.signal });
  assert.deepEqual((await pages.next()).value, [{ id: 1 }]);
  controller.abort();
  await assert.rejects(pages.next(), /abort/i);
  assert.deepEqual(calls, [1]);
});

test('an abort while consuming the last page still rejects the scan', async () => {
  const { client } = fixture([{ count: 1, next: null, data: [{ id: 1 }] }]);
  const controller = new AbortController();
  const pages = client.paginate('/transactions', {}, { signal: controller.signal });
  await pages.next();
  controller.abort();
  await assert.rejects(pages.next(), /abort/i);
});

test('a server page-size cap without next still follows the total count', async () => {
  const { client, calls } = fixture([
    { count: 3, results: [{ id: 1 }, { id: 2 }] },
    { count: 3, results: [{ id: 3 }] },
  ]);
  assert.deepEqual(await client.getAll('/transactions'), [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.deepEqual(calls, [1, 2]);
});

test('invalid and contradictory successful responses cannot masquerade as an empty sync', async () => {
  for (const body of ['<html>login</html>', { detail: 'not authenticated' }, null,
    { count: 3, next: '?page=2', data: [] }, { count: 3, next: null, data: [{ id: 1 }] }]) {
    const { client } = fixture([body]);
    await assert.rejects(client.getAll('/transactions'), /invalid|incomplete|empty|pagination/i);
  }
});

test('a complete last page at the exact budget succeeds and a valid empty page succeeds', async () => {
  const full = fixture([{ count: 2, next: null, data: [1, 2] }]);
  assert.deepEqual(await full.client.getAll('/transactions', {}, { pageSize: 2, maxPages: 1 }), [1, 2]);
  assert.deepEqual(await fixture([{ count: 0, next: null, results: [] }]).client.getAll('/transactions'), []);
});
