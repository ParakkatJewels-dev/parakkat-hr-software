import test from 'node:test';
import assert from 'node:assert/strict';
import { weekDays, shiftWeek, punchSteps } from './weekStrip.js';

test('the week strip runs Monday to Sunday around the chosen day', () => {
  assert.deepEqual(weekDays('2026-10-22'), ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
  assert.equal(weekDays('2026-10-19')[0], '2026-10-19', 'a Monday starts its own week');
  assert.equal(weekDays('2026-10-25')[0], '2026-10-19', 'a Sunday ends the week before');
  assert.deepEqual(weekDays('2026-11-01').slice(0, 2), ['2026-10-26', '2026-10-27'], 'a week can span two months');
});

test('the arrows move a week at a time, across month and year ends', () => {
  assert.equal(shiftWeek('2026-10-22', 1), '2026-10-29');
  assert.equal(shiftWeek('2026-12-30', 1), '2027-01-06');
  assert.equal(shiftWeek('2026-03-03', -1), '2026-02-24');
});

test('punches read as in, breaks and returns, then out', () => {
  assert.deepEqual(punchSteps(['a']).map((s) => s.label), ['Checked in']);
  assert.deepEqual(punchSteps(['a', 'b']).map((s) => s.label), ['Checked in', 'Checked out']);
  assert.deepEqual(punchSteps(['a', 'b', 'c', 'd']).map((s) => s.label), ['Checked in', 'Break', 'Back to work', 'Checked out']);
  assert.deepEqual(punchSteps(null), []);
});
