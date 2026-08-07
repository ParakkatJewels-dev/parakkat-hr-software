import test from 'node:test';
import assert from 'node:assert/strict';
import { filterActionableNotifications } from './actionableNotifications.js';

test('resolved workflow notifications are no longer treated as needing attention', () => {
  const notifications = [
    { id: '1', type: 'leave', ref_id: 'leave-fixed', read_at: null },
    { id: '2', type: 'expense', ref_id: 'expense-open', read_at: null },
    { id: '3', type: 'ticket', ref_id: 'ticket-fixed', read_at: null },
  ];

  const actionable = filterActionableNotifications(notifications, {
    leave: { 'leave-fixed': 'Approved' },
    expense: { 'expense-open': 'Pending' },
    ticket: { 'ticket-fixed': 'Resolved' },
  });

  assert.deepEqual(actionable.map((n) => n.id), ['2']);
});

test('unknown or not-yet-loaded notification references stay visible', () => {
  const notifications = [
    { id: '1', type: 'document', ref_id: 'doc-1', read_at: null },
    { id: '2', type: 'leave', ref_id: 'leave-loading', read_at: null },
    { id: '3', type: 'task', ref_id: 'task-read', read_at: '2026-08-07T00:00:00Z' },
  ];

  const actionable = filterActionableNotifications(notifications, {});

  assert.deepEqual(actionable.map((n) => n.id), ['1', '2']);
});

test('deleted referenced workflow rows are not kept in needs-attention', () => {
  const actionable = filterActionableNotifications(
    [{ id: '1', type: 'regularization', ref_id: 'missing', read_at: null }],
    { regularization: {} }
  );

  assert.deepEqual(actionable, []);
});
