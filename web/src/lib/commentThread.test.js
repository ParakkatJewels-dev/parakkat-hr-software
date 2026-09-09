import test from 'node:test';
import assert from 'node:assert/strict';
import { buildThread, totalComments, mentionFor, replyToggleLabel } from './commentThread.js';

const c = (id, at, parent_id = null, name = 'Ramesh Kumar') => ({
  id,
  parent_id,
  body: id,
  created_at: `2026-09-20T10:${String(at).padStart(2, '0')}:00Z`,
  author: { full_name: name },
});

test('a flat list with no replies is all top level', () => {
  const t = buildThread([c('a', 1), c('b', 2)]);
  assert.deepEqual(t.map((x) => x.id), ['a', 'b']);
  assert.deepEqual(t.map((x) => x.replies.length), [0, 0]);
});

test('replies hang off their parent, oldest first', () => {
  const t = buildThread([c('a', 1), c('r2', 5, 'a'), c('r1', 3, 'a'), c('b', 2)]);
  assert.deepEqual(t.map((x) => x.id), ['a', 'b'], 'parents in time order');
  assert.deepEqual(t[0].replies.map((r) => r.id), ['r1', 'r2'], 'a conversation reads downwards');
});

test('input order does not matter — the thread is rebuilt from the timestamps', () => {
  const rows = [c('r1', 3, 'a'), c('b', 2), c('r2', 5, 'a'), c('a', 1)];
  const t = buildThread(rows);
  assert.deepEqual(t.map((x) => x.id), ['a', 'b']);
  assert.deepEqual(t[0].replies.map((r) => r.id), ['r1', 'r2']);
});

test('a reply whose parent is gone is promoted, not dropped', () => {
  // The parent was deleted between two fetches. Losing the answer too looks like data loss to
  // whoever wrote it.
  const t = buildThread([c('b', 2), c('orphan', 4, 'deleted-parent')]);
  assert.deepEqual(t.map((x) => x.id), ['b', 'orphan']);
  assert.equal(t.find((x) => x.id === 'orphan').replies.length, 0);
});

test('an empty or missing list is an empty thread, not a crash', () => {
  assert.deepEqual(buildThread([]), []);
  assert.deepEqual(buildThread(), []);
  assert.equal(totalComments([]), 0);
  assert.equal(totalComments(), 0);
});

test('a comment with an unparseable timestamp still appears', () => {
  const broken = { id: 'x', parent_id: null, created_at: 'not a date', body: 'x' };
  const t = buildThread([broken, c('a', 1)]);
  assert.equal(t.length, 2);
  assert.ok(t.some((x) => x.id === 'x'));
});

test('the count includes replies — the card badge is the whole conversation', () => {
  assert.equal(totalComments([c('a', 1), c('r', 2, 'a'), c('b', 3)]), 3);
});

test('answering someone seeds their first name only', () => {
  assert.equal(mentionFor(c('a', 1, null, 'Ramesh Kumar Nair')), '@Ramesh ');
  assert.equal(mentionFor(c('a', 1, null, 'Priya')), '@Priya ');
});

test('a comment with no readable author seeds nothing rather than "@undefined"', () => {
  assert.equal(mentionFor({ id: 'a' }), '');
  assert.equal(mentionFor({ id: 'a', author: { full_name: '   ' } }), '');
  assert.equal(mentionFor(null), '');
});

test('the reply disclosure counts, and singularises', () => {
  assert.equal(replyToggleLabel(1, false), 'View 1 reply');
  assert.equal(replyToggleLabel(4, false), 'View 4 replies');
  assert.equal(replyToggleLabel(1, true), 'Hide reply');
  assert.equal(replyToggleLabel(4, true), 'Hide replies');
  assert.equal(replyToggleLabel(0, false), '', 'no disclosure when there is nothing behind it');
});
