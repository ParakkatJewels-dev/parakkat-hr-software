import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  directKey, others, conversationName, previewOf, sortConversations, unreadTotal,
  groupByDay, showsSender, isMine, hasUnread, mediaPath,
} from './conversations.js';

const ME = 'emp-me';
const member = (id, name) => ({ employee_id: id, employee: name ? { id, full_name: name } : null });
const conv = (over = {}) => ({
  id: 'c1', kind: 'direct', title: null, members: [], unread_count: 0,
  last_message_at: '2026-09-10T10:00:00Z', ...over,
});

// ------------------------------------------------------------- the pair key ----

test('the key is the same whichever person asks for it', () => {
  assert.equal(directKey('aaa', 'bbb'), directKey('bbb', 'aaa'));
});

test('two different pairs get two different keys', () => {
  assert.notEqual(directKey('aaa', 'bbb'), directKey('aaa', 'ccc'));
});

test('a key needs both people', () => {
  assert.equal(directKey('aaa', null), null);
  assert.equal(directKey(null, 'bbb'), null);
});

// -------------------------------------------------------------------- naming ----

test('a one-to-one is named after the other person', () => {
  const c = conv({ members: [member(ME, 'Me'), member('emp-2', 'Meera')] });
  assert.equal(conversationName(c, ME), 'Meera');
});

test('a named group keeps its name', () => {
  const c = conv({ kind: 'group', title: 'Payroll team', members: [member(ME), member('x', 'A')] });
  assert.equal(conversationName(c, ME), 'Payroll team');
});

test('an unnamed group is named by who is in it', () => {
  const c = conv({
    kind: 'group', title: '   ',
    members: [member(ME, 'Me'), member('a', 'Anand'), member('b', 'Meera')],
  });
  assert.equal(conversationName(c, ME), 'Anand, Meera');
});

test('a big unnamed group names two and counts the rest', () => {
  const c = conv({
    kind: 'group',
    members: [member(ME, 'Me'), member('a', 'A'), member('b', 'B'), member('c', 'C'), member('d', 'D')],
  });
  assert.equal(conversationName(c, ME), 'A, B and 2 more');
});

test('somebody the viewer cannot read is Unknown, not blank', () => {
  // The employee embed comes back null for a person outside the viewer's scope. A nameless row in
  // the list reads as a broken conversation.
  const c = conv({ members: [member(ME, 'Me'), member('emp-2', null)] });
  assert.equal(conversationName(c, ME), 'Unknown');
});

test('a conversation with nobody else in it says so', () => {
  assert.equal(conversationName(conv({ members: [member(ME, 'Me')] }), ME), 'Just you');
  assert.equal(conversationName(conv({ kind: 'group', members: [member(ME, 'Me')] }), ME), 'Group');
});

test('others never includes you', () => {
  const c = conv({ members: [member(ME, 'Me'), member('a', 'A')] });
  assert.deepEqual(others(c, ME).map((m) => m.employee_id), ['a']);
});

// ------------------------------------------------------------------ previews ----

test('the preview is the last thing said', () => {
  assert.equal(previewOf(conv({ last_body: 'see you at 4', last_kind: 'text' }), ME), 'see you at 4');
});

test('media previews say what it was, not nothing', () => {
  assert.equal(previewOf(conv({ last_kind: 'image', last_body: null }), ME), 'Photo');
  assert.equal(previewOf(conv({ last_kind: 'video', last_body: null }), ME), 'Video');
  assert.equal(previewOf(conv({ last_kind: 'voice', last_body: null }), ME), 'Voice note');
  assert.equal(previewOf(conv({ last_kind: 'file', last_body: null }), ME), 'File');
});

test('a deleted last message says so rather than showing its words', () => {
  const c = conv({ last_body: 'oops', last_kind: 'text', last_deleted: true });
  assert.equal(previewOf(c, ME), 'Message deleted');
});

test('an empty conversation says there is nothing in it', () => {
  assert.equal(previewOf(conv({ last_body: null, last_kind: null }), ME), 'No messages yet');
  assert.equal(previewOf(conv({ last_body: '   ', last_kind: 'text' }), ME), 'No messages yet');
});

test('"You:" appears in a group and not in a one-to-one', () => {
  const g = conv({ kind: 'group', last_body: 'on it', last_kind: 'text', last_sender_id: ME });
  assert.equal(previewOf(g, ME), 'You: on it');

  const d = conv({ kind: 'direct', last_body: 'on it', last_kind: 'text', last_sender_id: ME });
  assert.equal(previewOf(d, ME), 'on it', 'there is only one other person, so it is obvious');
});

// -------------------------------------------------------------------- unread ----

test('the badge sums every conversation', () => {
  assert.equal(unreadTotal([conv({ unread_count: 2 }), conv({ unread_count: 3 })]), 5);
});

test('a missing or odd count does not make the badge NaN', () => {
  assert.equal(unreadTotal([conv({ unread_count: null }), conv({}), conv({ unread_count: '4' })]), 4);
  assert.equal(unreadTotal([]), 0);
  assert.equal(unreadTotal(undefined), 0);
});

test('hasUnread is about the count, not the loaded messages', () => {
  assert.equal(hasUnread(conv({ unread_count: 1 })), true);
  assert.equal(hasUnread(conv({ unread_count: 0 })), false);
  assert.equal(hasUnread(undefined), false);
});

// --------------------------------------------------------------------- order ----

test('the most recently active conversation is first', () => {
  const rows = sortConversations([
    conv({ id: 'old', last_message_at: '2026-09-01T00:00:00Z' }),
    conv({ id: 'new', last_message_at: '2026-09-10T00:00:00Z' }),
  ]);
  assert.deepEqual(rows.map((c) => c.id), ['new', 'old']);
});

test('sorting does not mutate the list it is given', () => {
  const rows = [conv({ id: 'a', last_message_at: '2026-09-01T00:00:00Z' }), conv({ id: 'b', last_message_at: '2026-09-10T00:00:00Z' })];
  sortConversations(rows);
  assert.deepEqual(rows.map((c) => c.id), ['a', 'b']);
});

// ------------------------------------------------------------------- threads ----

const msg = (over = {}) => ({ id: 'm', sender_id: 'a', created_at: '2026-09-10T10:00:00Z', ...over });

test('a thread breaks into days, oldest first', () => {
  const days = groupByDay([
    msg({ id: '1', created_at: '2026-09-09T10:00:00Z' }),
    msg({ id: '2', created_at: '2026-09-10T09:00:00Z' }),
    msg({ id: '3', created_at: '2026-09-10T11:00:00Z' }),
  ]);
  assert.deepEqual(days.map((d) => d.day), ['2026-09-09', '2026-09-10']);
  assert.deepEqual(days[1].messages.map((m) => m.id), ['2', '3']);
});

test('a message with no timestamp is skipped rather than making a day called undefined', () => {
  const days = groupByDay([msg({ created_at: null }), msg({ id: 'ok' })]);
  assert.equal(days.length, 1);
  assert.deepEqual(days[0].messages.map((m) => m.id), ['ok']);
});

test('an empty thread has no days', () => {
  assert.deepEqual(groupByDay([]), []);
  assert.deepEqual(groupByDay(undefined), []);
});

// -------------------------------------------------------------- who is talking ----

test('a one-to-one never repeats the sender — there is only one other person', () => {
  const a = msg({ sender_id: 'a' });
  const b = msg({ sender_id: 'b' });
  assert.equal(showsSender(b, a, { kind: 'direct' }), false);
});

test('a group names whoever just started talking', () => {
  const a = msg({ sender_id: 'a', created_at: '2026-09-10T10:00:00Z' });
  const b = msg({ sender_id: 'b', created_at: '2026-09-10T10:00:30Z' });
  assert.equal(showsSender(b, a, { kind: 'group' }), true);
});

test('a run from one person in a group is named once', () => {
  const first = msg({ sender_id: 'a', created_at: '2026-09-10T10:00:00Z' });
  const second = msg({ sender_id: 'a', created_at: '2026-09-10T10:00:30Z' });
  assert.equal(showsSender(second, first, { kind: 'group' }), false);
});

test('the same person after a long gap is named again — it is a new thought', () => {
  const first = msg({ sender_id: 'a', created_at: '2026-09-10T10:00:00Z' });
  const later = msg({ sender_id: 'a', created_at: '2026-09-10T14:00:00Z' });
  assert.equal(showsSender(later, first, { kind: 'group' }), true);
});

test('the first message in a group is always named', () => {
  assert.equal(showsSender(msg(), null, { kind: 'group' }), true);
});

test('my message is mine, and nobody is mine without an employee record', () => {
  assert.equal(isMine(msg({ sender_id: ME }), ME), true);
  assert.equal(isMine(msg({ sender_id: 'other' }), ME), false);
  assert.equal(isMine(msg({ sender_id: ME }), null), false);
});

// ---------------------------------------------------------------- media paths ----

test('the conversation id leads the path, because the storage policy reads it back out', () => {
  assert.match(mediaPath('conv-1', 'photo.jpg'), /^conv-1\//);
});

test('a hostile filename cannot climb out of its folder', () => {
  const path = mediaPath('conv-1', '../../etc/passwd');
  assert.match(path, /^conv-1\//);
  assert.ok(!path.includes('..'), 'no traversal survives');
  assert.ok(!path.slice('conv-1/'.length).includes('/'), 'and no extra folders');
});

test('two files sent in the same moment do not collide', () => {
  assert.notEqual(mediaPath('c', 'a.jpg'), mediaPath('c', 'a.jpg'));
});

test('the extension survives, so the browser still knows what it is', () => {
  assert.match(mediaPath('c', 'holiday.png'), /\.png$/);
});
