// The numbers on the per-person attendance screen.
//
//   npm test
//
// Built from Kasinath's real July 2026, which is what found the bug: his Sunday shift was left out
// of both the hours total and the overtime, so the screen disagreed with his payslip and with Easy
// Time Pro's own export. Every figure here is one somebody checks against something else, and each
// has been wrong at least once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarise } from './attendanceSummary.js';

const shift = { is_flexible: true, full_day_minutes: 510 };

/** One row, in the shape PostgREST returns. */
const day = (work_date, o = {}) => ({
  work_date,
  status: 'Present',
  day_type: 'working',
  worked_minutes: 0,
  ot_minutes: 0,
  late_minutes: 0,
  day_fraction: 1,
  check_in: `${work_date}T09:30:00+05:30`,
  check_out: `${work_date}T18:00:00+05:30`,
  shift,
  ...o,
});

// HO90-D7324, July 2026 — the five days that carry overtime, plus one plain day.
const KASINATH = [
  day('2026-07-11', { worked_minutes: 512, ot_minutes: 2 }),
  day('2026-07-17', { worked_minutes: 525, ot_minutes: 15 }),
  day('2026-07-25', { worked_minutes: 547, ot_minutes: 37 }),
  day('2026-07-26', {
    worked_minutes: 269, ot_minutes: 269,
    day_type: 'weekly_off', status: 'Weekly Off',
  }),
  day('2026-07-27', { worked_minutes: 543, ot_minutes: 33 }),
  day('2026-07-28', { worked_minutes: 480, ot_minutes: 0 }),
];

test('overtime counts the Sunday, because Sunday work is overtime here', () => {
  const s = summarise(KASINATH);
  // 2 + 15 + 37 + 269 + 33 = 356 minutes. It read 1.5 h while the Sunday's 269 were dropped.
  assert.equal(s.otHours, Math.round((356 / 60) * 10) / 10);
  assert.equal(s.otHours, 5.9);
});

test('total hours include every day worked, days off included', () => {
  const s = summarise(KASINATH);
  const everyMinute = KASINATH.reduce((a, r) => a + r.worked_minutes, 0); // 2876
  assert.equal(s.workedHours, Math.round((everyMinute / 60) * 10) / 10);
});

test('regular and overtime still add up to the total, exactly', () => {
  // The reason the split is shown as two parts of one figure rather than two figures: if these
  // ever stop summing, the screen is claiming the overtime is extra on top.
  const s = summarise(KASINATH);
  assert.equal(Math.round((s.normalHours + s.otHours) * 10) / 10, s.workedHours);
});

test('the day-off overtime is reported separately but is part of the total', () => {
  const s = summarise(KASINATH);
  assert.equal(s.offDayOtHours, 4.5, '269 minutes on the 26th');
  assert.ok(s.otHours > s.offDayOtHours, 'and it is inside the overtime figure, not beside it');
});

test('rates and averages still ignore days off, which is what they are for', () => {
  const s = summarise(KASINATH);
  // Five working days here; the Sunday must not become a sixth or dilute the percentages.
  assert.equal(s.workingDays, 5);
  assert.equal(s.offDays, 1);
  assert.equal(s.attendanceRate, 100, 'five working days, all attended');
});

test('a short day is counted short against the daily hours, not against a clock', () => {
  const s = summarise(KASINATH);
  // 480 on the 28th is under the 510 target; the other four working days clear it.
  assert.equal(s.shortDays, 1);
  assert.equal(s.flexible, true);
});

test('an empty month does not produce NaN or a divide by zero', () => {
  const s = summarise([]);
  assert.equal(s.workedHours, 0);
  assert.equal(s.otHours, 0);
  assert.equal(s.attendanceRate, null);
  assert.equal(s.hoursMetRate, null);
});

test('a month of nothing but days off reports its hours rather than dropping them', () => {
  // The failure this file exists for, in its purest form: if only days off are in range, counting
  // "working days only" reports zero hours for someone who demonstrably worked.
  const s = summarise([
    day('2026-07-26', { worked_minutes: 269, ot_minutes: 269, day_type: 'weekly_off', status: 'Weekly Off' }),
  ]);
  assert.equal(s.workedHours, 4.5);
  assert.equal(s.otHours, 4.5);
  assert.equal(s.workingDays, 0);
});
