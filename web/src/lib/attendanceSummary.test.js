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
import { summarise, explainDay, asHoursMinutes, insideMinutes, onSiteMinutes } from './attendanceSummary.js';

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

// ---------------------------------------------------------------------------
// explainDay — why the overtime is not the number you expected
// ---------------------------------------------------------------------------

const GN = { break_minutes: 40, full_day_minutes: 510, is_flexible: true };

/** Kasinath, 29 July 2026 — the day that prompted this. */
const REAL_DAY = {
  work_date: '2026-07-29',
  status: 'Present',
  day_type: 'working',
  worked_minutes: 515,
  ot_minutes: 5,
  break_minutes: 79,
  breaks_incomplete: false,
  punches: [
    '2026-07-29T09:37:00+05:30', '2026-07-29T13:23:00+05:30', '2026-07-29T13:42:00+05:30',
    '2026-07-29T13:48:00+05:30', '2026-07-29T14:14:00+05:30', '2026-07-29T15:47:00+05:30',
    '2026-07-29T16:21:00+05:30', '2026-07-29T18:51:00+05:30',
  ],
  shift: GN,
};

test('the day shows the whole subtraction, not just the answer', () => {
  const x = explainDay(REAL_DAY, GN);
  const byLabel = (frag) => x.lines.find((l) => l.label.includes(frag));

  assert.equal(byLabel('On site').minutes, 554, '09:37 to 18:51');
  assert.equal(byLabel('Out of the office').minutes, -79, 'every minute punched out');
  assert.equal(byLabel('Inside the office').minutes, 554 - 79, 'what he is really asking for');
  assert.equal(byLabel('Break allowance').minutes, 40, '40 of the 79 given back');
  assert.equal(byLabel('Counted as worked').minutes, 515);
  assert.equal(byLabel('Overtime').minutes, 5);
});

test('the ledger reconciles: inside + the free allowance is the payable figure', () => {
  // The point of showing both. If these ever stop adding up, one of the two numbers on screen is
  // lying and there is no way for the reader to tell which.
  // Breaks only. A day with no break punch has no out-of-office and no inside line: the person
  // never left, so "On site, first punch to last" already IS the inside time and a second row
  // repeating it would be noise. The expandable ledger only opens on days with a timeline anyway.
  for (const brk of [15, 40, 41, 79, 200]) {
    const worked = 554 - Math.max(0, brk - 40);
    const x = explainDay({ ...REAL_DAY, break_minutes: brk, worked_minutes: worked }, GN);
    const at = (frag) => x.lines.find((l) => l.label.includes(frag))?.minutes ?? 0;
    assert.equal(
      at('Inside the office') + at('Break allowance'),
      at('Counted as worked'),
      `break of ${brk} min`
    );
  }
});

test('a day with no break shows no inside line, because on site already says it', () => {
  const x = explainDay({ ...REAL_DAY, break_minutes: 0, worked_minutes: 554 }, GN);
  assert.equal(x.lines.find((l) => l.label.includes('Inside the office')), undefined);
  assert.equal(x.lines.find((l) => l.label.includes('On site')).minutes, 554);
  // …and the column figure still resolves, which is what the table reads.
  assert.equal(insideMinutes({ ...REAL_DAY, break_minutes: 0 }), 554);
});

test('inside time is the day less every minute punched out', () => {
  assert.equal(insideMinutes(REAL_DAY), 554 - 79);
  // Nobody punched a break: they never left, so the whole day was inside.
  assert.equal(insideMinutes({ ...REAL_DAY, break_minutes: 0 }), 554);
  assert.equal(onSiteMinutes(REAL_DAY), 554);
  // Nothing to measure.
  assert.equal(onSiteMinutes({ punches: [] }), null);
  assert.equal(insideMinutes({ punches: [] }), null);
});

test('and says in one sentence why the overtime is smaller than it looks', () => {
  const x = explainDay(REAL_DAY, GN);
  assert.match(x.note, /39 min of break beyond the 40-minute allowance/);
});

test('a break inside the allowance costs nothing and is shown as costing nothing', () => {
  const x = explainDay({ ...REAL_DAY, break_minutes: 30, worked_minutes: 554, ot_minutes: 44 }, GN);
  const b = x.lines.find((l) => l.label.includes('Break allowance'));
  assert.equal(b.minutes, 30, 'all 30 given back, so nothing is charged');
  assert.equal(b.muted, true, 'shown, but visibly not charged');
  assert.equal(
    x.lines.find((l) => l.label.includes('Inside the office')).minutes, 554 - 30,
    'and the inside figure still says he was out for 30'
  );
  assert.equal(x.note, null, 'nothing needs explaining away');
});

test('a short day says short, not negative overtime', () => {
  const x = explainDay({ ...REAL_DAY, break_minutes: 0, worked_minutes: 400, ot_minutes: 0 }, GN);
  const last = x.lines[x.lines.length - 1];
  assert.match(last.label, /Short of a full day/);
  assert.equal(last.minutes, 400 - 510);
});

test('nothing to explain when there is no pair of punches', () => {
  assert.equal(explainDay({ punches: [] }, GN), null);
  assert.equal(explainDay({ punches: ['2026-07-29T09:37:00+05:30'] }, GN), null);
  assert.equal(explainDay(null, GN), null);
});

test('durations read as hours and minutes, signed', () => {
  assert.equal(asHoursMinutes(515), '8h 35m');
  assert.equal(asHoursMinutes(-39), '−39m');
  assert.equal(asHoursMinutes(5), '5m');
  assert.equal(asHoursMinutes(0), '0m');
});

test('an odd punch count says a stretch is unaccounted for, and that the total is a floor', () => {
  // The reported case: in, out for break, back from break, home without punching.
  const x = explainDay({
    worked_minutes: 270, ot_minutes: 0, break_minutes: 0, breaks_incomplete: true,
    punches: [
      '2026-07-15T09:00:00+05:30', '2026-07-15T13:00:00+05:30', '2026-07-15T13:30:00+05:30',
    ],
  }, { break_minutes: 40, full_day_minutes: 510 });

  assert.ok(x.incomplete);
  assert.ok(x.lines.some((l) => l.label.includes('unaccounted for') && l.minutes === null),
    'the unknown stretch has no number, and must not be shown as zero');
  assert.match(x.lines.find((l) => l.total).label, /at least/,
    'the total is labelled a floor, not a measurement');
  assert.match(x.note, /either the last punch is a break/, 'names both readings');
  assert.match(x.note, /Raise a correction/, 'and says what to do');
});

test('a complete day says none of that', () => {
  const x = explainDay(REAL_DAY, GN);
  assert.equal(x.incomplete, false);
  assert.equal(x.lines.some((l) => l.minutes === null), false);
  assert.doesNotMatch(x.lines.find((l) => l.total).label, /at least/);
});

// ---------------------------------------------------------------------------
// inside vs worked — the two must be totalled over the same days
// ---------------------------------------------------------------------------

/** A single-punch day: the engine credits a full day from the schedule, nothing is measurable. */
const RECONSTRUCTED = {
  work_date: '2026-07-15', status: 'Present', day_type: 'working',
  worked_minutes: 510, ot_minutes: 0, break_minutes: 0, day_fraction: 1,
  punches: ['2026-07-15T17:31:00+05:30'], shift: GN,
};

/** A measured day: in, one hour of lunch, out. Inside 8h, credited 8h40m. */
const MEASURED = {
  work_date: '2026-07-16', status: 'Present', day_type: 'working',
  worked_minutes: 520, ot_minutes: 10, break_minutes: 60, day_fraction: 1,
  punches: [
    '2026-07-16T09:00:00+05:30', '2026-07-16T13:00:00+05:30',
    '2026-07-16T14:00:00+05:30', '2026-07-16T18:00:00+05:30',
  ],
  shift: GN,
};

test('a month of unmeasurable days does not invent a break allowance', () => {
  // The bug this pins: inside summed with `?? 0` over days that still carry worked_minutes made
  // the tile print the whole month's hours as forgiven break. Akhil Aji's real screen read
  // "Total hours 90.8, Inside 0.0" and claimed 90.8 h of allowance against an actual 0.0.
  const s = summarise([RECONSTRUCTED, RECONSTRUCTED, RECONSTRUCTED]);
  assert.equal(s.workedHours, 25.5, 'still paid three full days');
  assert.equal(s.insideHours, 0, 'nothing was measurable');
  assert.equal(s.insideAllowanceHours, 0, 'and so NO allowance may be claimed');
  assert.equal(s.unmeasuredDays, 3, 'the tile has to say it cannot speak for these');
});

test('the allowance is measured over the measurable days only', () => {
  const s = summarise([MEASURED, RECONSTRUCTED]);
  // Inside and the allowance both describe the one measured day: 8h inside, 40 min given back.
  assert.equal(s.insideHours, 8);
  assert.equal(s.insideAllowanceHours, 0.7, '40 minutes, to one decimal');
  assert.equal(s.unmeasuredDays, 1);
  // The payable total is untouched by any of this.
  assert.equal(s.workedHours, Math.round(((520 + 510) / 60) * 10) / 10);
});

test('with every day measured, inside + allowance is the payable figure', () => {
  const s = summarise([MEASURED, MEASURED]);
  assert.equal(s.unmeasuredDays, 0);
  assert.equal(
    Math.round((s.insideHours + s.insideAllowanceHours) * 10) / 10,
    s.workedHours,
    'the identity the tile is built on'
  );
});
