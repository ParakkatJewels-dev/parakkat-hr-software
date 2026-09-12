import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isIncomingRequest, belongsInChatSection, canSendToConversation } from './messageRequests.js';

const pending = { kind: 'direct', created_by: 'sender', request_status: 'pending', request_recipient_id: 'recipient', last_message_id: 'message' };

test('incoming cross-branch requests are separate from all, unread and group chats', () => {
  assert.equal(isIncomingRequest(pending, 'recipient'), true);
  assert.equal(isIncomingRequest(pending, 'sender'), false);
  assert.equal(belongsInChatSection(pending, 'recipient', 'requests'), true);
  for (const section of ['all', 'unread', 'groups']) assert.equal(belongsInChatSection(pending, 'recipient', section), false);
  assert.equal(belongsInChatSection(pending, 'sender', 'all'), true);
  assert.equal(belongsInChatSection({ ...pending, last_message_id: null }, 'recipient', 'requests'), false);
});

test('acceptance returns requests to chats and decline removes them from the recipient list', () => {
  for (const me of ['recipient', 'sender']) {
    assert.equal(belongsInChatSection({ ...pending, request_status: 'accepted' }, me, 'all'), true);
  }
  const declined = { ...pending, request_status: 'declined' };
  assert.equal(belongsInChatSection(declined, 'recipient', 'all'), false);
  assert.equal(belongsInChatSection(declined, 'recipient', 'requests'), false);
  assert.equal(belongsInChatSection(declined, 'sender', 'all'), true);
});

test('pending senders can write, recipients must accept first, and declined requests cannot send', () => {
  assert.equal(canSendToConversation(pending, 'sender'), true);
  assert.equal(canSendToConversation(pending, 'recipient'), false);
  assert.equal(canSendToConversation({ ...pending, request_status: 'declined' }, 'sender'), false);
  assert.equal(canSendToConversation({ kind: 'direct' }, 'recipient'), true);
  assert.equal(canSendToConversation({ kind: 'group' }, 'recipient'), true);
});
