import test from 'node:test';
import assert from 'node:assert/strict';
import { spanLabel } from './assetSpan.js';

const NOW = new Date('2026-08-05T12:00:00Z');

test('an open spell runs to now, so a laptop handed over in April reads as months held', () => {
  assert.equal(spanLabel('2026-04-05T00:00:00Z', null, NOW), '4 months');
});

test('a spell shorter than a day is today, not "0 days"', () => {
  assert.equal(spanLabel('2026-08-05T09:00:00Z', null, NOW), 'today');
});

test('days stay days until a month has passed', () => {
  assert.equal(spanLabel('2026-08-04T12:00:00Z', '2026-08-05T12:00:00Z', NOW), '1 day');
  assert.equal(spanLabel('2026-07-24T12:00:00Z', '2026-08-05T12:00:00Z', NOW), '12 days');
  assert.equal(spanLabel('2026-07-06T12:00:00Z', '2026-08-05T12:00:00Z', NOW), '30 days');
});

test('months take over, then years', () => {
  assert.equal(spanLabel('2026-06-05T12:00:00Z', '2026-08-05T12:00:00Z', NOW), '2 months');
  assert.equal(spanLabel('2025-08-05T12:00:00Z', '2026-08-05T12:00:00Z', NOW), '1 year');
  assert.equal(spanLabel('2024-06-05T12:00:00Z', '2026-08-05T12:00:00Z', NOW), '2y 2m');
});

test('a closed spell ignores the clock — history does not grow', () => {
  const closed = spanLabel('2020-01-01T00:00:00Z', '2020-03-01T00:00:00Z', NOW);
  assert.equal(closed, spanLabel('2020-01-01T00:00:00Z', '2020-03-01T00:00:00Z', new Date('2030-01-01T00:00:00Z')));
});

test('a closed spell of a few hours is "same day", not "today" — it may be years ago', () => {
  assert.equal(spanLabel('2020-01-09T09:00:00Z', '2020-01-09T18:00:00Z', NOW), 'same day');
  assert.equal(spanLabel('2020-01-09T18:00:00Z', '2020-01-10T09:00:00Z', NOW), 'same day');
  // Still running and started this morning: 'today' is right.
  assert.equal(spanLabel('2026-08-05T09:00:00Z', null, NOW), 'today');
});

test('months of unequal length still count whole months', () => {
  // 31 Jan -> 30 Apr is three whole months even though 30 < 31.
  assert.equal(spanLabel('2024-01-31T00:00:00Z', '2024-04-30T00:00:00Z', NOW), '3 months');
  // 29 Jan -> 28 Feb the following year is 13 months, not 12.
  assert.equal(spanLabel('2024-01-29T00:00:00Z', '2025-02-28T00:00:00Z', NOW), '1y 1m');
  // A genuinely incomplete month is still short.
  assert.equal(spanLabel('2024-01-15T00:00:00Z', '2024-04-14T00:00:00Z', NOW), '2 months');
});

test('nonsense in, null out — a returned date before the handover is not a negative span', () => {
  assert.equal(spanLabel(null, null, NOW), null);
  assert.equal(spanLabel('not-a-date', null, NOW), null);
  assert.equal(spanLabel('2026-08-05T12:00:00Z', '2026-01-01T00:00:00Z', NOW), null);
});

test('singular and plural both read correctly', () => {
  assert.equal(spanLabel('2026-07-04T12:00:00Z', '2026-08-05T12:00:00Z', NOW), '1 month');
  assert.equal(spanLabel('2026-08-03T12:00:00Z', '2026-08-05T12:00:00Z', NOW), '2 days');
});
