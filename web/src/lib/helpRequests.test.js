import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  incomingRequests, outgoingRequests, pendingCount, preferenceOutcome, sortRequests,
  daysWaiting, stalledRequests, requestFlow, requestTotals,
} from './helpRequests.js';

const req = (o) => ({
  id: o.id, status: o.status ?? 'Pending',
  from_department_id: o.from ?? 'dA', to_department_id: o.to ?? 'dB',
  preferred: o.preferred ? { id: o.preferred } : null,
  assignee: o.assignee ? { id: o.assignee } : null,
  created_at: o.created_at ?? '2026-09-01T00:00:00Z',
});

const MINE = ['dA'];

test('a request addressed to my department is mine to answer', () => {
  assert.deepEqual(incomingRequests([req({ id: '1', from: 'dB', to: 'dA' })], MINE).map((r) => r.id), ['1']);
});

test('a request I raised is not something I answer', () => {
  assert.deepEqual(incomingRequests([req({ id: '1', from: 'dA', to: 'dB' })], MINE), []);
  assert.deepEqual(outgoingRequests([req({ id: '1', from: 'dA', to: 'dB' })], MINE).map((r) => r.id), ['1']);
});

test('a head who runs BOTH departments sees it as incoming, not as both', () => {
  // Otherwise the same row appears twice on one screen, once as a thing to do and once as a thing
  // to wait for. Answering it is the actionable half, so that is the half it counts as.
  const both = ['dA', 'dB'];
  const rows = [req({ id: '1', from: 'dA', to: 'dB' })];
  assert.equal(incomingRequests(rows, both).length, 1);
  assert.equal(outgoingRequests(rows, both).length, 0);
});

test('only what is waiting ON me is badged', () => {
  const rows = [
    req({ id: '1', from: 'dB', to: 'dA', status: 'Pending' }),
    req({ id: '2', from: 'dB', to: 'dA', status: 'Accepted' }),
    req({ id: '3', from: 'dA', to: 'dB', status: 'Pending' }),   // I raised this one
  ];
  assert.equal(pendingCount(rows, MINE), 1);
});

test('nothing to answer is zero, not a crash', () => {
  assert.equal(pendingCount([], MINE), 0);
  assert.equal(pendingCount(undefined, undefined), 0);
});

test('taking the suggested person reads as honoured', () => {
  assert.equal(preferenceOutcome(req({ id: '1', status: 'Accepted', preferred: 'p1', assignee: 'p1' })), 'honoured');
});

test('giving it to somebody else is called out', () => {
  // The requester asked for a named person and got a different one. That is exactly the thing they
  // need to notice, so it gets its own answer rather than reading as a plain acceptance.
  assert.equal(preferenceOutcome(req({ id: '1', status: 'Accepted', preferred: 'p1', assignee: 'p2' })), 'overridden');
});

test('no preference means there was nothing to honour or override', () => {
  assert.equal(preferenceOutcome(req({ id: '1', status: 'Accepted', assignee: 'p2' })), 'no-preference');
});

test('an unanswered or refused request has no preference outcome', () => {
  assert.equal(preferenceOutcome(req({ id: '1', status: 'Pending', preferred: 'p1' })), null);
  assert.equal(preferenceOutcome(req({ id: '1', status: 'Declined', preferred: 'p1' })), null);
  assert.equal(preferenceOutcome(null), null);
});

test('what is still waiting floats above what is settled', () => {
  const order = sortRequests([
    req({ id: 'settled-new', status: 'Accepted', created_at: '2026-09-08T00:00:00Z' }),
    req({ id: 'waiting-old', status: 'Pending',  created_at: '2026-01-01T00:00:00Z' }),
  ]).map((r) => r.id);
  assert.deepEqual(order, ['waiting-old', 'settled-new']);
});

test('within the same state, newest first', () => {
  const order = sortRequests([
    req({ id: 'older', status: 'Pending', created_at: '2026-01-01T00:00:00Z' }),
    req({ id: 'newer', status: 'Pending', created_at: '2026-06-01T00:00:00Z' }),
  ]).map((r) => r.id);
  assert.deepEqual(order, ['newer', 'older']);
});

test('sorting does not mutate the list it is given', () => {
  const input = [req({ id: 'a', status: 'Accepted' }), req({ id: 'b', status: 'Pending' })];
  sortRequests(input);
  assert.deepEqual(input.map((r) => r.id), ['a', 'b']);
});

/* --------------------------- the org-wide view, for an administrator --------------------------- */


const NOW = new Date('2026-09-20T10:00:00Z');
const ask = (over = {}) => ({
  status: 'Pending',
  created_at: '2026-09-19T10:00:00Z',
  from_department: { name: 'Casting' },
  to_department: { name: 'Polishing' },
  ...over,
});

test('only a pending request ages', () => {
  assert.equal(daysWaiting(ask({ created_at: '2026-09-10T10:00:00Z' }), NOW), 10);
  assert.equal(
    daysWaiting(ask({ status: 'Accepted', created_at: '2026-09-10T10:00:00Z' }), NOW), 0,
    'an answered request stopped waiting'
  );
  assert.equal(daysWaiting(ask({ created_at: null }), NOW), 0);
  assert.equal(daysWaiting(ask({ created_at: 'not a date' }), NOW), 0);
});

test('the stalled queue is oldest first, because that is the end being chased', () => {
  const rows = stalledRequests([
    ask({ created_at: '2026-09-18T10:00:00Z', title: 'new' }),
    ask({ created_at: '2026-09-01T10:00:00Z', title: 'old' }),
    ask({ created_at: '2026-09-10T10:00:00Z', title: 'mid' }),
    ask({ status: 'Accepted', created_at: '2026-08-01T10:00:00Z', title: 'answered' }),
  ], { now: NOW });
  assert.deepEqual(rows.map((r) => r.title), ['old', 'mid', 'new']);
});

test('the stalled queue can be limited to what has waited long enough', () => {
  const rows = stalledRequests([
    ask({ created_at: '2026-09-19T10:00:00Z', title: 'yesterday' }),
    ask({ created_at: '2026-09-01T10:00:00Z', title: 'ages' }),
  ], { minDays: 7, now: NOW });
  assert.deepEqual(rows.map((r) => r.title), ['ages']);
});

test('the flow folds one row per department pair, busiest first', () => {
  const rows = requestFlow([
    ask({ status: 'Accepted' }),
    ask({ status: 'Pending' }),
    ask({ from_department: { name: 'Polishing' }, to_department: { name: 'Casting' }, status: 'Declined' }),
  ]);
  assert.equal(rows.length, 2, 'direction matters: Casting->Polishing is not Polishing->Casting');
  assert.deepEqual(rows[0], { from: 'Casting', to: 'Polishing', total: 2, pending: 1, accepted: 1, declined: 0 });
  assert.deepEqual(rows[1], { from: 'Polishing', to: 'Casting', total: 1, pending: 0, accepted: 0, declined: 1 });
});

test('a missing department name does not drop the row', () => {
  const rows = requestFlow([ask({ from_department: null })]);
  assert.equal(rows[0].from, 'Unknown');
  assert.equal(rows[0].total, 1);
});

test('totals separate what is merely pending from what has been ignored a week', () => {
  const t = requestTotals([
    ask({ created_at: '2026-09-19T10:00:00Z' }),
    ask({ created_at: '2026-09-01T10:00:00Z' }),
    ask({ status: 'Accepted' }),
    ask({ status: 'Declined' }),
  ], NOW);
  assert.deepEqual(t, { total: 4, pending: 2, accepted: 1, declined: 1, stalled: 1 });
});

test('no requests at all gives zeroes rather than throwing', () => {
  assert.deepEqual(requestTotals([], NOW), { total: 0, pending: 0, accepted: 0, declined: 0, stalled: 0 });
  assert.deepEqual(requestFlow([]), []);
  assert.deepEqual(stalledRequests([]), []);
});
