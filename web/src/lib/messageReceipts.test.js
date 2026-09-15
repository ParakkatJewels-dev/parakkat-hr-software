import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiptCoversMessage, messageDeliveryStatus, mergeConversationReceipts } from './messageReceipts.js';

const stamp = '2026-09-12T10:00:00.123456+00:00';
const message = { id: 'b', sender_id: 'sender', created_at: stamp };
const member = { employee_id: 'recipient', joined_at: '2026-09-01T00:00:00Z' };
const conversation = (...recipients) => ({ members: [{ employee_id: 'sender' }, ...recipients] });

test('ticks distinguish saved, delivered and seen, without counting the sender as a recipient', () => {
  assert.equal(messageDeliveryStatus(message, conversation(member)), 'sent');
  assert.equal(messageDeliveryStatus(message, conversation({ ...member, last_delivered_at: stamp })), 'delivered');
  assert.equal(messageDeliveryStatus(message, conversation({ ...member, last_read_at: stamp })), 'seen');
  assert.equal(messageDeliveryStatus(message, conversation()), 'sent');
});

test('receipt cursors preserve microseconds, timezone equivalence and same-time message order', () => {
  assert.equal(receiptCoversMessage({ last_read_at: stamp, last_read_message_id: 'a' }, message), false);
  assert.equal(receiptCoversMessage({ last_read_at: stamp, last_read_message_id: 'b' }, message), true);
  assert.equal(receiptCoversMessage({ last_read_at: '2026-09-12T10:00:00.123455Z' }, message), false);
  assert.equal(receiptCoversMessage({ last_read_at: '2026-09-12T15:30:00.123456+05:30' }, message), true);
  assert.equal(receiptCoversMessage({ last_read_at: 'invalid' }, message), false);
});

test('group double ticks require every recipient present when the message was sent', () => {
  const seen = { ...member, last_read_at: stamp, last_delivered_at: stamp };
  const delivered = { ...member, employee_id: 'second', last_delivered_at: stamp };
  assert.equal(messageDeliveryStatus(message, conversation(seen, delivered)), 'delivered');
  assert.equal(messageDeliveryStatus(message, conversation(seen, { ...delivered, last_read_at: stamp })), 'seen');
  assert.equal(messageDeliveryStatus(message, conversation(seen, { employee_id: 'new', joined_at: '2026-09-13T00:00:00Z' })), 'seen');
});

test('requests do not expose seen status until the recipient accepts', () => {
  const room = conversation({ ...member, last_read_at: stamp, last_delivered_at: stamp });
  assert.equal(messageDeliveryStatus(message, { ...room, request_status: 'pending' }), 'delivered');
  assert.equal(messageDeliveryStatus(message, { ...room, request_status: 'declined' }), 'delivered');
});

test('live receipt events update the matching member while preserving names and other conversations', () => {
  const room = { ...conversation({ ...member, employee: { full_name: 'Recipient' } }), id: 'room' };
  const other = { id: 'other', members: [{ ...member }] };
  const original = { pending: false, conversations: [room, other] };
  const event = { conversation_id: 'room', employee_id: member.employee_id, last_delivered_at: stamp,
    last_delivered_message_id: message.id, last_read_at: stamp, last_read_message_id: message.id };
  const updated = mergeConversationReceipts(original, event);
  assert.equal(messageDeliveryStatus(message, updated.conversations[0]), 'seen');
  assert.equal(updated.conversations[0].members[1].employee.full_name, 'Recipient');
  assert.equal(updated.conversations[1], other);
  assert.equal(original.conversations[0], room);
  assert.equal(messageDeliveryStatus(message, room), 'sent', 'the prior React Query result is immutable');
  assert.equal(mergeConversationReceipts(updated, event), updated, 'duplicate events retain object identity');
  assert.equal(messageDeliveryStatus(message, mergeConversationReceipts([room], event)[0]), 'seen', 'monitor caches use an array');
});

test('delayed receipt events cannot move ticks backwards across microseconds or cursor IDs', () => {
  const event = { conversation_id: 'room', employee_id: member.employee_id,
    last_read_at: stamp, last_read_message_id: 'c', last_delivered_at: stamp, last_delivered_message_id: 'c' };
  const current = mergeConversationReceipts([{ id: 'room', ...conversation(member) }], event);
  for (const stale of [
    { ...event, last_read_message_id: 'a', last_delivered_message_id: 'a' },
    { ...event, last_read_at: '2026-09-12T10:00:00.123455Z', last_delivered_at: '2026-09-12T10:00:00.123455Z' },
    { ...event, last_read_at: null, last_delivered_at: null },
    { ...event, employee_id: 'outsider' },
    { ...event, conversation_id: 'another-room' },
  ]) assert.equal(mergeConversationReceipts(current, stale), current);
  assert.equal(mergeConversationReceipts(undefined, event), undefined, 'an event cannot create an unread conversation');
});
