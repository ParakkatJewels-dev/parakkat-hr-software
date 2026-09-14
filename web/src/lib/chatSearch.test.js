import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchChatSearchPage, CHAT_SEARCH_PAGE_SIZE } from './chatSearch.js';

test('chat search sends literal text and a paired cursor to the authorized history RPC', async () => {
  const rows = Array.from({ length: CHAT_SEARCH_PAGE_SIZE + 1 }, (_, i) => ({ id: `message-${i}`, created_at: `timestamp-${i}` }));
  const calls = [];
  const client = { rpc: async (...args) => { calls.push(args); return { data: rows, error: null }; } };
  const first = await fetchChatSearchPage(client, 'room', '  50%_off*  ');
  assert.deepEqual(calls[0], ['search_chat_messages', { _conversation_id: 'room', _query: '50%_off*',
    _before_at: null, _before_id: null, _limit: CHAT_SEARCH_PAGE_SIZE + 1 }]);
  assert.equal(first.messages.length, CHAT_SEARCH_PAGE_SIZE);
  assert.deepEqual(first.nextCursor, rows[CHAT_SEARCH_PAGE_SIZE - 1]);
  await fetchChatSearchPage(client, 'room', '50%_off*', first.nextCursor);
  assert.equal(calls[1][1]._before_at, first.nextCursor.created_at);
  assert.equal(calls[1][1]._before_id, first.nextCursor.id);
});

test('empty searches make no requests and a final page has no continuation', async () => {
  const unused = { rpc: () => assert.fail('must not query an empty search') };
  assert.deepEqual(await fetchChatSearchPage(unused, 'room', '   '), { messages: [], nextCursor: null });
  assert.deepEqual(await fetchChatSearchPage(unused, null, 'hello'), { messages: [], nextCursor: null });
  assert.deepEqual(await fetchChatSearchPage({ rpc: async () => ({ data: [{ id: 'last' }] }) }, 'room', 'hello'),
    { messages: [{ id: 'last' }], nextCursor: null });
});

test('search failures remain errors instead of looking like no matches', async () => {
  const problem = new Error('Permission denied');
  await assert.rejects(fetchChatSearchPage({ rpc: async () => ({ error: problem }) }, 'room', 'hello'), problem);
  await assert.rejects(fetchChatSearchPage({ rpc: async () => ({ data: null }) }, 'room', 'hello'), /Search could not be loaded/);
});
