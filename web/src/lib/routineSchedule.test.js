import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routineEditStartDate } from './routineSchedule.js';

const interval = (start_date, interval_days = 3) => ({ frequency: 'interval', start_date, interval_days });

test('adding a job between interval occurrences defaults to the next due date without shifting cadence', () => {
  assert.equal(routineEditStartDate(interval('2026-09-26'), '2026-09-28'), '2026-09-29');
  assert.equal(routineEditStartDate(interval('2026-09-26'), '2026-09-29'), '2026-09-29');
  assert.equal(routineEditStartDate(interval('2026-09-26'), '2026-10-01'), '2026-10-02');
});

test('upcoming interval routines retain their first date and one-day intervals allow today', () => {
  assert.equal(routineEditStartDate(interval('2026-10-02'), '2026-09-28'), '2026-10-02');
  assert.equal(routineEditStartDate(interval('2026-09-26', 1), '2026-09-28'), '2026-09-28');
});

test('interval defaults use calendar days across leap months and year boundaries', () => {
  assert.equal(routineEditStartDate(interval('2024-02-27'), '2024-02-28'), '2024-03-01');
  assert.equal(routineEditStartDate(interval('2026-12-30'), '2027-01-01'), '2027-01-02');
});

test('other frequencies and incomplete schedule input retain ordinary edit defaults', () => {
  assert.equal(routineEditStartDate({ frequency: 'daily', start_date: '2026-09-20' }, '2026-09-28'), '2026-09-28');
  assert.equal(routineEditStartDate({ frequency: 'once', start_date: '2026-10-02' }, '2026-09-28'), '2026-10-02');
  assert.equal(routineEditStartDate(undefined, '2026-09-28'), '2026-09-28');
  assert.equal(routineEditStartDate(interval('2026-09-26', 0), '2026-09-28'), '2026-09-28');
});
