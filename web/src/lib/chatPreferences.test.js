import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyChatPreference, chatPreferencesKey, fetchChatPreferences, setChatPreference } from './chatPreferences.js';

const conversationId = 'e0000000-0000-0000-0000-000000000001';
function clientFor({ data = [{ conversation_id: conversationId, is_pinned: true, is_favourite: false }], error = null } = {}) {
  const calls = [];
  return { calls, async rpc(name, parameters) { calls.push([name, parameters]); return { data, error }; } };
}

test('preference cache keys isolate both login changes and employee relinking', () => {
  assert.notDeepEqual(chatPreferencesKey('first', 'staff'), chatPreferencesKey('second', 'staff'));
  assert.notDeepEqual(chatPreferencesKey('first', 'staff'), chatPreferencesKey('first', 'relinked'));
  assert.deepEqual(chatPreferencesKey(), ['chat-preferences', null, null]);
});

test('pin toggle sends only that flag and never accepts an employee identity from the client', async () => {
  const client = clientFor();
  await setChatPreference(client, { conversationId, isPinned: true, employeeId: 'someone-else' });
  assert.deepEqual(client.calls, [['set_chat_preference', { _conversation_id: conversationId, _is_pinned: true }]]);
});

test('false is an explicit clear and omitted pin survives a favourite-only request', async () => {
  const client = clientFor({ data: [{ conversation_id: conversationId, is_pinned: true, is_favourite: false }] });
  assert.deepEqual(await setChatPreference(client, { conversationId, isFavourite: false }),
    { conversation_id: conversationId, is_pinned: true, is_favourite: false });
  assert.deepEqual(client.calls, [['set_chat_preference', { _conversation_id: conversationId, _is_favourite: false }]]);
});

test('both flags can be persisted together and invalid inputs never send a request', async () => {
  const client = clientFor();
  await setChatPreference(client, { conversationId, isPinned: false, isFavourite: true });
  assert.deepEqual(client.calls[0], ['set_chat_preference', { _conversation_id: conversationId, _is_pinned: false, _is_favourite: true }]);
  for (const input of [{}, { isPinned: true }, { conversationId }, { conversationId, isPinned: null },
    { conversationId, isPinned: 'false' }, { conversationId, isFavourite: 1 }]) {
    await assert.rejects(setChatPreference(client, input), /Choose|true or false/);
  }
  assert.equal(client.calls.length, 1);
});

test('permission errors and unconfirmed responses cannot be reported as saved', async () => {
  const error = new Error('Only members may change preferences');
  await assert.rejects(setChatPreference(clientFor({ error }), { conversationId, isPinned: true }), (actual) => actual === error);
  for (const data of [null, [], [{ conversation_id: 'different', is_pinned: true, is_favourite: false }],
    [{ conversation_id: conversationId, is_pinned: 'true', is_favourite: false }]]) {
    await assert.rejects(setChatPreference(clientFor({ data }), { conversationId, isPinned: true }), /Could not confirm/);
  }
});

test('confirmed preferences update one conversation without mutating other saved choices', () => {
  const original = [{ conversation_id: 'z', is_pinned: true, is_favourite: false },
    { conversation_id: 'a', is_pinned: false, is_favourite: true }];
  const saved = { conversation_id: 'z', is_pinned: false, is_favourite: false };
  assert.deepEqual(applyChatPreference(original, saved), [original[1], saved]);
  assert.equal(original[0].is_pinned, true);
  assert.deepEqual(applyChatPreference(undefined, saved), [saved]);
});

test('preferences paginate through a server row cap with only personal display fields', async () => {
  const rows = Array.from({ length: 503 }, (_, index) => ({ conversation_id: String(index).padStart(4, '0'),
    is_pinned: index % 2 === 0, is_favourite: index % 3 === 0 }));
  let requests = 0;
  const client = { from(table) {
    assert.equal(table, 'chat_preferences');
    const query = {
      select(fields) { assert.equal(fields, 'conversation_id,is_pinned,is_favourite'); return query; },
      order(field) { assert.equal(field, 'conversation_id'); return query; },
      async range(from, to) { requests++; return { data: rows.slice(from, Math.min(to + 1, from + 37)), error: null }; },
    };
    return query;
  } };
  assert.deepEqual(await fetchChatPreferences(client), rows);
  assert.ok(requests > 2);
});
