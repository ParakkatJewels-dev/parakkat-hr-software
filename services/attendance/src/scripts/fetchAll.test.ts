// The weekly chunking, tested on its own.
//
//   npx tsx --test src/scripts/fetchAll.test.ts
//
// A year is fifty-odd requests against an on-prem box. An off-by-one here either skips a day of
// punches — invisible until somebody queries that date months later — or re-requests days that
// were already collected, doubling the load for nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weeks } from './fetchAll';

const days = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

test('chunks are contiguous, non-overlapping, and cover the range exactly', () => {
  const from = '2025-09-01';
  const to = '2026-07-28';
  const w = weeks(from, to);

  assert.equal(w[0]!.from, from, 'starts on the requested day');
  assert.equal(w[w.length - 1]!.to, to, 'ends on the requested day');

  let covered = 0;
  for (const [i, c] of w.entries()) {
    assert.ok(c.from <= c.to, `chunk ${i} is not backwards`);
    covered += days(c.from, c.to);
    if (i > 0) {
      const prevEnd = Date.parse(`${w[i - 1]!.to}T00:00:00Z`);
      const thisStart = Date.parse(`${c.from}T00:00:00Z`);
      assert.equal(thisStart - prevEnd, 86_400_000,
        `chunk ${i} must start the day after chunk ${i - 1} ends — no gap, no overlap`);
    }
  }
  assert.equal(covered, days(from, to), 'every day in the range is covered exactly once');
});

test('a range shorter than a week is one chunk', () => {
  const w = weeks('2026-07-27', '2026-07-28');
  assert.equal(w.length, 1);
  assert.deepEqual(w[0], { from: '2026-07-27', to: '2026-07-28' });
});

test('a single day is one chunk of that day', () => {
  assert.deepEqual(weeks('2026-07-28', '2026-07-28'), [{ from: '2026-07-28', to: '2026-07-28' }]);
});

test('an exactly-7-day range is one chunk, not two', () => {
  const w = weeks('2026-07-01', '2026-07-07');
  assert.equal(w.length, 1, 'the boundary case that produces a stray 1-day request');
  assert.equal(w[0]!.to, '2026-07-07');
});

test('an 8-day range is two chunks and the second is a single day', () => {
  const w = weeks('2026-07-01', '2026-07-08');
  assert.equal(w.length, 2);
  assert.deepEqual(w[1], { from: '2026-07-08', to: '2026-07-08' });
});

test('a backwards range produces nothing rather than looping forever', () => {
  assert.deepEqual(weeks('2026-07-28', '2026-07-01'), []);
});

test('the range spans a leap day without losing it', () => {
  const w = weeks('2028-02-25', '2028-03-03');
  const all = w.flatMap((c) => [c.from, c.to]);
  assert.ok(w.length >= 1);
  assert.equal(all[0], '2028-02-25');
  assert.equal(all[all.length - 1], '2028-03-03');
});
