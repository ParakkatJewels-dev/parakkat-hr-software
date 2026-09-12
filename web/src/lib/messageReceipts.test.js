import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiptCoversMessage, messageDeliveryStatus } from './messageReceipts.js';

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
