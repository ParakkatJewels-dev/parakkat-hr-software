import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterActionableNotifications, groupUnreadNotifications, idsToMarkRead,
} from './actionableNotifications.js';

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


// ------------------------------------------------------- grouping the strip ----

const notif = (o) => ({
  id: o.id, type: o.type ?? 'leave', title: o.title ?? 'New leave request',
  tab: o.tab ?? 'leave', ref_id: o.ref_id ?? null, read_at: o.read_at ?? null,
});

test('identical unread notifications collapse into one row with a count', () => {
  const groups = groupUnreadNotifications([
    notif({ id: 'a' }), notif({ id: 'b' }), notif({ id: 'c' }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 3);
});

test('a collapsed row carries EVERY id it stands for', () => {
  // The bug this exists to catch: the row spread the first member and kept one id, so it rendered
  // "3" while representing one notification. Marking it read left the other two unread forever.
  const groups = groupUnreadNotifications([
    notif({ id: 'a' }), notif({ id: 'b' }), notif({ id: 'c' }),
  ]);
  assert.deepEqual(groups[0].ids, ['a', 'b', 'c']);
  assert.equal(groups[0].ids.length, groups[0].count, 'the badge must not claim more than the row holds');
});

test('different titles, tabs or types stay separate rows', () => {
  const groups = groupUnreadNotifications([
    notif({ id: 'a', title: 'New leave request' }),
    notif({ id: 'b', title: 'Expense submitted', type: 'expense', tab: 'expense' }),
    notif({ id: 'c', title: 'New leave request', tab: 'tasks' }),
  ]);
  assert.equal(groups.length, 3);
});

test('already-read notifications never reach the strip', () => {
  const groups = groupUnreadNotifications([
    notif({ id: 'a', read_at: '2026-09-08T00:00:00Z' }),
    notif({ id: 'b' }),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].ids, ['b']);
});

test('grouping an empty or missing list is not an error', () => {
  assert.deepEqual(groupUnreadNotifications([]), []);
  assert.deepEqual(groupUnreadNotifications(undefined), []);
});

// ------------------------------------------------- what an open should clear ----

test('opening a single unread notification marks that one read', () => {
  assert.deepEqual(idsToMarkRead(notif({ id: 'a' })), ['a']);
});

test('opening one already read marks nothing — no pointless write', () => {
  assert.deepEqual(idsToMarkRead(notif({ id: 'a', read_at: '2026-09-08T00:00:00Z' })), []);
});

test('opening a collapsed row clears the whole group, not just its first member', () => {
  // The reported bug, stated as a rule: the dashboard strip navigated and marked nothing, so the
  // bell badge kept counting items the user had already dealt with.
  const [group] = groupUnreadNotifications([notif({ id: 'a' }), notif({ id: 'b' }), notif({ id: 'c' })]);
  assert.deepEqual(idsToMarkRead(group), ['a', 'b', 'c']);
});

test('nothing to open is not a crash', () => {
  assert.deepEqual(idsToMarkRead(null), []);
  assert.deepEqual(idsToMarkRead(undefined), []);
});
