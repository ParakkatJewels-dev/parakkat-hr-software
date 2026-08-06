// Rule tests for the attendance engine.
//
//   npx tsx --test src/engine/rules.test.ts
//
// processDay is pure, so every rule is exercised without a database or a BioTime connection.
// The four edge cases the brief calls out each have a test here, because they are exactly the
// ones that produce plausible-looking wrong numbers rather than obvious errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  processDay, dedupePunches, fullDayLeaveConflictsWithPunch, punchWindow,
} from './processDay';
import { workDateAtTime } from '../lib/time';
import type { DayInput, PunchRecord, ShiftDefinition } from './types';

const GENERAL: ShiftDefinition = {
  id: 'shift-general',
  code: 'GEN',
  name: 'General',
  startTime: '09:30:00',
  endTime: '18:30:00',
  crossesMidnight: false,
  graceInMinutes: 15,
  graceOutMinutes: 15,
  breakMinutes: 60,
  breakPolicy: 'fixed',
  weeklyOffs: [0],
  fullDayMinutes: 480,
  halfDayMinutes: 240,
  otAfterMinutes: 30,
  minOtMinutes: 30,
  otBasis: 'schedule',
  missedPunchPolicy: 'exception',
  lateAbsentMinutes: 540,
  earlyAbsentMinutes: 540,
  shortDayToleranceMinutes: 30,
  isFlexible: false,
};

/**
 * What the company actually runs, as of migration 0062: Easy Time Pro's own General Time Table
 * window, a 40-minute allowance charged only on the overrun, and no fixed start — the employee
 * owes the daily hours and chooses when to work them.
 */
const FLEXIBLE: ShiftDefinition = {
  ...GENERAL,
  id: 'shift-flexible',
  code: 'GN',
  name: 'General (flexible)',
  startTime: '09:00:00',
  endTime: '17:30:00',
  breakMinutes: 40,
  breakPolicy: 'excess',
  fullDayMinutes: 510,
  halfDayMinutes: 255,
  otBasis: 'worked',
  isFlexible: true,
};

// 22:00 -> 06:00 is 480 scheduled minutes; a 30-minute unpaid break leaves 450 workable. Setting
// fullDayMinutes above that would make a full day unreachable — which the
// shifts_full_day_reachable_check constraint in 0013 now rejects at the database level.
const NIGHT: ShiftDefinition = {
  ...GENERAL,
  id: 'shift-night',
  code: 'NGT',
  name: 'Night',
  startTime: '22:00:00',
  endTime: '06:00:00',
  crossesMidnight: true,
  breakMinutes: 30,
  fullDayMinutes: 450,
  halfDayMinutes: 225,
};

let punchId = 0;
const punchAt = (date: string, clock: string, dayOffset = 0): PunchRecord => ({
  id: BigInt(++punchId),
  punchTime: workDateAtTime(date, clock, dayOffset),
  punchState: null,
  terminalSn: 'T1',
  terminalAlias: 'Gate',
});

function day(overrides: Partial<DayInput> = {}): DayInput {
  return {
    employeeId: 'emp-1',
    workDate: '2026-07-15', // a Wednesday
    shift: GENERAL,
    dayType: 'working',
    holidayName: null,
    punches: [],
    leave: null,
    regularization: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// the happy path
// ---------------------------------------------------------------------------

test('a normal full day is Present with a full payable day', () => {
  const r = processDay(day({ punches: [punchAt('2026-07-15', '09:25'), punchAt('2026-07-15', '18:35')] }));

  assert.equal(r.status, 'Present');
  assert.equal(r.dayFraction, 1);
  assert.equal(r.isLate, false);
  assert.equal(r.isEarlyExit, false);
  assert.equal(r.workedMinutes, 550 - 60); // 09:25 -> 18:35 minus the 60m break
  assert.equal(r.otMinutes, 0);
});

// ---------------------------------------------------------------------------
// lateness / early exit / overtime
// ---------------------------------------------------------------------------

test('arriving inside the grace period is not late', () => {
  const r = processDay(day({ punches: [punchAt('2026-07-15', '09:44'), punchAt('2026-07-15', '18:35')] }));
  assert.equal(r.isLate, false);
  assert.equal(r.lateMinutes, 0);
});

test('arriving past the grace period is late, counted from the scheduled start', () => {
  const r = processDay(day({ punches: [punchAt('2026-07-15', '10:05'), punchAt('2026-07-15', '18:35')] }));
  assert.equal(r.isLate, true);
  assert.equal(r.lateMinutes, 20); // 35 late, minus 15 grace
});

test('leaving early past the grace period is flagged', () => {
  const r = processDay(day({ punches: [punchAt('2026-07-15', '09:25'), punchAt('2026-07-15', '17:00')] }));
  assert.equal(r.isEarlyExit, true);
  assert.equal(r.earlyExitMinutes, 75); // 90 early, minus 15 grace
});

test('overtime only counts past the OT threshold', () => {
  const short = processDay(day({ punches: [punchAt('2026-07-15', '09:25'), punchAt('2026-07-15', '18:50')] }));
  assert.equal(short.otMinutes, 0, '20 minutes over is below otAfter + minOt');

  const real = processDay(day({ punches: [punchAt('2026-07-15', '09:25'), punchAt('2026-07-15', '20:00')] }));
  assert.equal(real.otMinutes, 60); // 90 over, minus the 30m threshold
});

// ---------------------------------------------------------------------------
// edge case 1: single punch days
// ---------------------------------------------------------------------------

test('a single punch is Missing Punch, not a zero-hour Present and not Absent', () => {
  const r = processDay(day({ punches: [punchAt('2026-07-15', '09:28')] }));

  assert.equal(r.status, 'Missing Punch');
  assert.equal(r.isMissingPunch, true);
  assert.equal(r.checkIn?.getTime(), workDateAtTime('2026-07-15', '09:28').getTime());
  assert.equal(r.checkOut, null);
  assert.equal(r.dayFraction, 0.5, 'half credit pending regularization');
});

test('no punches at all on a working day is Absent', () => {
  const r = processDay(day());
  assert.equal(r.status, 'Absent');
  assert.equal(r.dayFraction, 0);
});

// ---------------------------------------------------------------------------
// edge case 2: night shifts crossing midnight
// ---------------------------------------------------------------------------

test('a night shift credits the next-morning exit to the day it started', () => {
  const r = processDay(
    day({
      shift: NIGHT,
      punches: [punchAt('2026-07-15', '21:55'), punchAt('2026-07-15', '06:05', 1)],
    })
  );

  assert.equal(r.status, 'Present');
  assert.equal(r.workedMinutes, 490 - 30);
  assert.equal(r.isLate, false);
  assert.equal(r.isEarlyExit, false);
  assert.equal(r.scheduledOut?.getTime(), workDateAtTime('2026-07-15', '06:00', 1).getTime());
});

test('the night-shift punch window spans midnight', () => {
  const { from, to } = punchWindow('2026-07-15', NIGHT);
  const exit = workDateAtTime('2026-07-15', '06:05', 1);

  assert.ok(exit >= from && exit < to, 'the 06:05 next-day punch falls inside the window');
});

// ---------------------------------------------------------------------------
// edge case 3: duplicate punches within a minute
// ---------------------------------------------------------------------------

test('double-taps on the reader collapse into one punch', () => {
  const punches = [
    punchAt('2026-07-15', '09:25:00'),
    punchAt('2026-07-15', '09:25:08'), // double tap
    punchAt('2026-07-15', '09:25:41'), // still the same arrival
    punchAt('2026-07-15', '18:35:00'),
  ];

  assert.equal(dedupePunches(punches, 60).length, 2);

  const r = processDay(day({ punches }));
  assert.equal(r.punchCount, 2);
  assert.equal(r.status, 'Present');
});

test('a day whose only punches are a double-tap is Missing Punch, not a 8-second day', () => {
  const r = processDay(
    day({ punches: [punchAt('2026-07-15', '09:25:00'), punchAt('2026-07-15', '09:25:08')] })
  );

  assert.equal(r.status, 'Missing Punch');
  // Deduped to a single arrival, so the day runs to the scheduled 18:30 rather than lasting eight
  // seconds. Clipped to the 09:30 start, that is 540 minutes less the 60-minute allowance.
  assert.equal(r.workedMinutes, 540 - 60);
});

// ---------------------------------------------------------------------------
// edge case 4: no shift assigned
// ---------------------------------------------------------------------------

test('an employee with no shift is No Shift, never Absent', () => {
  const r = processDay(day({ shift: null }));

  assert.equal(r.status, 'No Shift');
  assert.equal(r.remarks, 'No shift assigned for this date');
  assert.notEqual(r.status, 'Absent');
});

test('no shift still records worked time when both punches exist', () => {
  const r = processDay(
    day({ shift: null, punches: [punchAt('2026-07-15', '09:00'), punchAt('2026-07-15', '17:00')] })
  );

  assert.equal(r.status, 'No Shift');
  assert.equal(r.workedMinutes, 480);
});

// ---------------------------------------------------------------------------
// calendar rules
// ---------------------------------------------------------------------------

test('Sunday is a weekly off and is paid', () => {
  const r = processDay(day({ workDate: '2026-07-19' })); // a Sunday
  assert.equal(r.status, 'Weekly Off');
  assert.equal(r.dayType, 'weekly_off');
  assert.equal(r.dayFraction, 1);
});

test('working on a weekly off reads as Present, and the whole day is overtime', () => {
  const r = processDay(
    day({
      workDate: '2026-07-19',
      punches: [punchAt('2026-07-19', '10:00'), punchAt('2026-07-19', '15:00')],
    })
  );

  // Present, because they were. The status used to stay 'Weekly Off' whatever the punches said, so
  // a Sunday somebody worked drew the same 'W' in the calendar as one spent at home and was left
  // out of the monthly present count.
  assert.equal(r.status, 'Present');
  assert.equal(r.otMinutes, 240); // 5h on site, minus the 60m break

  // The day was STILL a rest day, and everything that depends on knowing that must survive the
  // relabelling: day_type is what reports ask to find who is working weekends, and dayFraction is
  // what payroll sums — if this moved off 1, the change would have quietly altered pay.
  assert.equal(r.dayType, 'weekly_off');
  assert.equal(r.dayFraction, 1);
  assert.match(r.remarks ?? '', /Worked on weekly off/);
});

test('a rest day nobody worked is untouched', () => {
  const r = processDay(day({ workDate: '2026-07-19' }));
  assert.equal(r.status, 'Weekly Off');
  assert.equal(r.otMinutes, 0);
});

// The hours cannot be measured from one press of the button, and a working day's trick of
// rebuilding the missing half from the schedule cannot apply — nobody was scheduled. Calling that
// Present would be a guess dressed as a fact, so it stays an exception for HR to regularize.
test('a lone punch on a rest day is still an exception, not Present', () => {
  const r = processDay(
    day({ workDate: '2026-07-19', punches: [punchAt('2026-07-19', '10:00')] })
  );

  assert.equal(r.status, 'Weekly Off');
  assert.equal(r.isMissingPunch, true);
  assert.equal(r.otMinutes, 0);
});

test('working a holiday reads as Present too', () => {
  const r = processDay(
    day({
      dayType: 'holiday',
      holidayName: 'Onam',
      punches: [punchAt('2026-07-15', '10:00'), punchAt('2026-07-15', '15:00')],
    })
  );

  assert.equal(r.status, 'Present');
  assert.equal(r.dayType, 'holiday');
  assert.equal(r.dayFraction, 1);
  assert.match(r.remarks ?? '', /Worked on holiday/);
});

test('a holiday is Holiday and paid', () => {
  const r = processDay(day({ dayType: 'holiday', holidayName: 'Onam' }));
  assert.equal(r.status, 'Holiday');
  assert.equal(r.dayFraction, 1);
  assert.equal(r.remarks, 'Onam');
});

// ---------------------------------------------------------------------------
// leave and LOP
// ---------------------------------------------------------------------------

test('approved paid leave overrides Absent', () => {
  const r = processDay(
    day({ leave: { id: 'lv-1', type: 'CL', dayFraction: 1, isLop: false, isPaid: true } })
  );

  assert.equal(r.status, 'On Leave');
  assert.equal(r.leaveType, 'CL');
  assert.equal(r.dayFraction, 1);
  assert.equal(r.isLop, false);
});

test('LOP leave is recorded as leave but pays nothing', () => {
  const r = processDay(
    day({ leave: { id: 'lv-2', type: 'LOP', dayFraction: 1, isLop: true, isPaid: false } })
  );

  assert.equal(r.status, 'On Leave');
  assert.equal(r.isLop, true);
  assert.equal(r.dayFraction, 0);
  assert.equal(r.remarks, 'Loss of pay');
});

test('half-day leave plus a worked half is one full paid day', () => {
  const r = processDay(
    day({
      leave: { id: 'lv-3', type: 'CL', dayFraction: 0.5, isLop: false, isPaid: true },
      punches: [punchAt('2026-07-15', '14:00'), punchAt('2026-07-15', '18:35')],
    })
  );

  assert.equal(r.status, 'On Leave');
  assert.equal(r.dayFraction, 1);
});

test('a terminal punch cancels full-day leave before the day is scored', () => {
  const leave = { id: 'lv-4', type: 'CL', dayFraction: 1, isLop: false, isPaid: true };
  const punches = [punchAt('2026-07-15', '09:25'), punchAt('2026-07-15', '18:35')];

  assert.equal(fullDayLeaveConflictsWithPunch(leave, punches), true);

  const r = processDay(day({
    punches,
    // recompute removes the conflicting leave overlay after cancelling it in the database
    leave: fullDayLeaveConflictsWithPunch(leave, punches) ? null : leave,
  }));
  assert.equal(r.status, 'Present');
  assert.equal(r.leaveId, null);
  assert.equal(r.dayFraction, 1);
});

test('leave is not auto-cancelled without a punch or when it covers only half a day', () => {
  const fullDay = { id: 'lv-5', type: 'CL', dayFraction: 1, isLop: false, isPaid: true };
  const halfDay = { ...fullDay, id: 'lv-6', dayFraction: 0.5 };
  const punches = [punchAt('2026-07-15', '14:00')];

  assert.equal(fullDayLeaveConflictsWithPunch(fullDay, []), false);
  assert.equal(fullDayLeaveConflictsWithPunch(halfDay, punches), false);
});

// ---------------------------------------------------------------------------
// regularization
// ---------------------------------------------------------------------------

test('an approved regularization supplies the missing check-out', () => {
  const r = processDay(
    day({
      punches: [punchAt('2026-07-15', '09:25')],
      regularization: { id: 'reg-1', checkIn: null, checkOut: workDateAtTime('2026-07-15', '18:30') },
    })
  );

  assert.equal(r.status, 'Present');
  assert.equal(r.isMissingPunch, false);
  assert.equal(r.regularizationId, 'reg-1');
  assert.equal(r.source, 'regularized');
  assert.equal(r.dayFraction, 1);
});

// ---------------------------------------------------------------------------
// idempotence
// ---------------------------------------------------------------------------

test('the same input always produces the same result', () => {
  const input = day({ punches: [punchAt('2026-07-15', '09:47'), punchAt('2026-07-15', '19:20')] });
  assert.deepEqual(processDay(input), processDay(input));
});

// ---------------------------------------------------------------------------
// breaks
//
// The terminals report punch_state 255 on every record, so a punch never says whether it is an
// entry or an exit. Pairing is by order alone. The day below is a real shape from the Kalamassery
// terminal — arrive, tea, lunch, tea, leave.
// ---------------------------------------------------------------------------

test('middle punches are measured as breaks', () => {
  const r = processDay(
    day({
      punches: [
        punchAt('2026-07-15', '09:39'),
        punchAt('2026-07-15', '10:38'), punchAt('2026-07-15', '10:53'), // 15m
        punchAt('2026-07-15', '13:02'), punchAt('2026-07-15', '13:36'), // 34m
        punchAt('2026-07-15', '15:36'), punchAt('2026-07-15', '16:05'), // 29m
        punchAt('2026-07-15', '18:33'),
      ],
    })
  );

  assert.equal(r.punchCount, 8);
  assert.equal(r.breakMinutes, 15 + 34 + 29);
  assert.equal(r.breaksIncomplete, false);
  assert.equal(r.checkIn?.getHours(), 9);
  assert.equal(r.checkOut?.getHours(), 18);
});

test("'fixed' costs the allowance, 'actual' costs what was measured", () => {
  const punches = [
    punchAt('2026-07-15', '09:00'),
    punchAt('2026-07-15', '12:00'), punchAt('2026-07-15', '14:00'), // a 120-minute lunch
    punchAt('2026-07-15', '18:00'),
  ];
  const span = 9 * 60; // 09:00 -> 18:00

  const fixed = processDay(day({ punches }));
  assert.equal(fixed.breakMinutes, 120, 'measured either way');
  assert.equal(fixed.workedMinutes, span - GENERAL.breakMinutes, 'but only the allowance is deducted');

  const actual = processDay(day({ punches, shift: { ...GENERAL, breakPolicy: 'actual' } }));
  assert.equal(actual.workedMinutes, span - 120);
  // 420 is a full day, 360 is not — this is exactly the kind of day the policy switch moves.
  assert.equal(fixed.status, 'Present');
  assert.equal(actual.status, 'Half Day');
});

test("'actual' deducts nothing when nobody punched a break", () => {
  // In and out, nothing between. This is the common shape here — 440 of 602 completed days — and
  // charging each the standard hour removed 440 hours of worked time for breaks nobody took.
  const r = processDay(
    day({
      shift: { ...GENERAL, breakPolicy: 'actual' },
      punches: [punchAt('2026-07-15', '09:00'), punchAt('2026-07-15', '17:30')],
    })
  );
  assert.equal(r.breakMinutes, 0);
  assert.equal(r.breaksIncomplete, false, 'two punches are complete, not missing anything');
  assert.equal(r.workedMinutes, 8 * 60 + 30, 'the whole span is worked time');
});

test("'actual' deducts exactly what was punched when a break was taken", () => {
  const r = processDay(
    day({
      shift: { ...GENERAL, breakPolicy: 'actual' },
      punches: [
        punchAt('2026-07-15', '09:00'),
        punchAt('2026-07-15', '13:00'), punchAt('2026-07-15', '13:40'), // 40m
        punchAt('2026-07-15', '17:30'),
      ],
    })
  );
  assert.equal(r.breakMinutes, 40);
  assert.equal(r.workedMinutes, 8 * 60 + 30 - 40, 'not the 60m allowance');
});

test('an unpaired middle punch is flagged and does not reduce pay', () => {
  const r = processDay(
    day({
      shift: { ...GENERAL, breakPolicy: 'actual' },
      punches: [
        punchAt('2026-07-15', '09:00'),
        punchAt('2026-07-15', '12:00'), punchAt('2026-07-15', '13:00'), punchAt('2026-07-15', '15:00'),
        punchAt('2026-07-15', '18:00'),
      ],
    })
  );

  assert.equal(r.breaksIncomplete, true, 'three middle punches cannot pair');
  assert.equal(r.breakMinutes, 60, 'measures the pair it can see');
  // Deducting a break total we know is short would overpay, so fall back to the allowance.
  assert.equal(r.workedMinutes, 9 * 60 - GENERAL.breakMinutes);
});

test('two punches describe no break at all', () => {
  const r = processDay({
    ...day({ punches: [punchAt('2026-07-15', '09:00'), punchAt('2026-07-15', '18:00')] }),
  });
  assert.equal(r.breakMinutes, 0);
  assert.equal(r.breaksIncomplete, false);
  assert.deepEqual(r.punches.length, 2);
});

test("'actual_over_allowance' protects the standard break and charges only the overrun", () => {
  const span = 9 * 60; // 09:00 -> 18:00 in every case below
  const shift = { ...GENERAL, breakPolicy: 'actual_over_allowance' as const };

  // A short break does NOT become extra credit — the hour is theirs either way.
  const short = processDay(
    day({
      shift,
      punches: [
        punchAt('2026-07-15', '09:00'),
        punchAt('2026-07-15', '13:00'), punchAt('2026-07-15', '13:30'), // 30m
        punchAt('2026-07-15', '18:00'),
      ],
    })
  );
  assert.equal(short.breakMinutes, 30);
  assert.equal(short.workedMinutes, span - GENERAL.breakMinutes, 'still the 60m allowance');

  // An overrun is charged in full.
  const long = processDay(
    day({
      shift,
      punches: [
        punchAt('2026-07-15', '09:00'),
        punchAt('2026-07-15', '12:00'), punchAt('2026-07-15', '14:53'), // 173m
        punchAt('2026-07-15', '18:00'),
      ],
    })
  );
  assert.equal(long.breakMinutes, 173);
  assert.equal(long.workedMinutes, span - 173);
});

test('a missing punch cannot buy back a long lunch', () => {
  // Five punches: the measured 120m is a floor, but it is real time away and exceeds the
  // allowance, so it is still charged. Skipping a punch must not be cheaper than taking the break.
  const r = processDay(
    day({
      shift: { ...GENERAL, breakPolicy: 'actual_over_allowance' },
      punches: [
        punchAt('2026-07-15', '09:00'),
        punchAt('2026-07-15', '12:00'), punchAt('2026-07-15', '14:00'), punchAt('2026-07-15', '15:00'),
        punchAt('2026-07-15', '18:00'),
      ],
    })
  );
  assert.equal(r.breaksIncomplete, true);
  assert.equal(r.breakMinutes, 120);
  assert.equal(r.workedMinutes, 9 * 60 - 120, 'the measured floor still beats the allowance');
});

// ---------------------------------------------------------------------------
// overtime basis
//
// The real shape of a day here is an early start and a 17:30-ish finish. Measuring overtime from
// the scheduled end awarded it on 15 days out of 594 while 419 of those days were over seven
// hours of work.
// ---------------------------------------------------------------------------

test("'worked' basis pays an early start that a schedule basis ignores", () => {
  // Murukan K B, 07-22: in at 07:56, out at 17:29. Eight and a half hours, finished before the
  // configured 18:30, so the schedule basis sees a short day and no overtime at all.
  // The live shift treats 420 minutes as a full day, not the 480 this file's fixture uses.
  const REAL = { ...GENERAL, fullDayMinutes: 420 };
  const punches = [punchAt('2026-07-15', '07:56'), punchAt('2026-07-15', '17:29')];
  const worked = 573 - GENERAL.breakMinutes; // 07:56 -> 17:29, less the break allowance

  const bySchedule = processDay(day({ punches, shift: REAL }));
  assert.equal(bySchedule.otMinutes, 0, 'left before the shift ended, so nothing counts');
  assert.equal(bySchedule.isEarlyExit, true);

  const byWorked = processDay(day({ punches, shift: { ...REAL, otBasis: 'worked' } }));
  assert.equal(byWorked.workedMinutes, worked);
  assert.equal(byWorked.otMinutes, worked - REAL.fullDayMinutes - REAL.otAfterMinutes);
  assert.ok(byWorked.otMinutes >= REAL.minOtMinutes, 'and it clears the floor, so it is recorded');
});

test("'worked' basis still refuses trivial overtime", () => {
  // Ten minutes past a full day is not an overtime claim.
  const shift = { ...GENERAL, otBasis: 'worked' as const };
  const r = processDay(
    day({
      shift,
      // 09:30 -> 18:10 is 520 gross, 460 worked: 40 beyond a full day, which is under
      // otAfterMinutes + minOtMinutes.
      punches: [punchAt('2026-07-15', '09:30'), punchAt('2026-07-15', '18:10')],
    })
  );
  assert.equal(r.workedMinutes, 460);
  assert.equal(r.otMinutes, 0);
});

test('the two bases agree when the extra time is all at the end of the day', () => {
  // Starting on time and staying late is the one case both rules describe identically — provided
  // the shift's net scheduled time equals a full day, which is what makes them comparable.
  const shift = { ...GENERAL, endTime: '17:30:00', fullDayMinutes: 420 };
  const punches = [punchAt('2026-07-15', '09:30'), punchAt('2026-07-15', '19:00')];

  const a = processDay(day({ punches, shift }));
  const b = processDay(day({ punches, shift: { ...shift, otBasis: 'worked' } }));
  assert.equal(a.otMinutes, b.otMinutes);
  assert.equal(a.otMinutes, 90 - GENERAL.otAfterMinutes);
});

// ---------------------------------------------------------------------------
// a lone punch: which end of the day is it?
//
// People forget to punch out in the morning and forget to punch in in the evening, and both are
// common here — 101 morning and 75 evening days out of 184. Treating every lone punch as an
// arrival marked all 75 as late by an average of 473 minutes.
// ---------------------------------------------------------------------------

test('a lone morning punch is an arrival, and lateness still applies', () => {
  const r = processDay(day({ punches: [punchAt('2026-07-15', '10:05')] }));

  assert.equal(r.status, 'Missing Punch');
  assert.equal(r.checkIn?.getHours(), 10, 'recorded as when they arrived');
  assert.equal(r.checkOut, null);
  assert.equal(r.isLate, true, '35 minutes past a 09:30 start, less 15 grace');
  assert.equal(r.lateMinutes, 20);
  assert.equal(r.dayFraction, 0.5);
  assert.match(r.remarks ?? '', /no check-out/);
});

test('a lone evening punch is a departure, and asserts no lateness', () => {
  // Narayanan.C.K's real 17:31, which used to read as "arrived, 466 minutes late".
  const r = processDay(day({ punches: [punchAt('2026-07-15', '17:31')] }));

  assert.equal(r.status, 'Missing Punch');
  assert.equal(r.checkIn, null, 'we do not know when he arrived');
  assert.equal(r.checkOut?.getHours(), 17, 'we do know when he left');
  assert.equal(r.isLate, false, 'the whole point — he was not late, he forgot to punch in');
  assert.equal(r.lateMinutes, 0);
  assert.equal(r.dayFraction, 0.5, 'still an exception for HR, still half credit');
  assert.match(r.remarks ?? '', /no check-in/);
});

// ---------------------------------------------------------------------------
// what a lone punch is WORTH.
//
// Not a full day, and not zero either: the day is measured from the punch that exists to the
// scheduled boundary on the side that is missing. The expectations below are lifted straight out
// of Easy Time Pro's own Monthly Status Report for July 2026 — NARAYANAN CK, employee 2020 — so
// these tests fail if we ever drift from the system the company already reconciles against.
//
// Scoring these zero, as the engine did before, left 196 days across 109 people unpaid in July
// alone.
// ---------------------------------------------------------------------------

// Easy Time Pro's own General Time Table, inferred from the Late and Early columns of its report:
// 09:00-17:30, and it deducts no break at all.
const THEIRS: ShiftDefinition = {
  ...GENERAL,
  id: 'shift-etp',
  code: 'GN',
  startTime: '09:00:00',
  endTime: '17:30:00',
  breakMinutes: 0,
  breakPolicy: 'excess',
  fullDayMinutes: 510,
  halfDayMinutes: 255,
};

const theirDay = (clock: string) =>
  processDay(day({ shift: THEIRS, punches: [punchAt('2026-07-15', clock)] }));

test('a lone arrival is worth the time from it to the shift end, not a full day', () => {
  // Their day 5: clocked in 12:45, never out. Their report says 04:45 — not 08:30.
  assert.equal(theirDay('12:45').workedMinutes, 285);

  // Their day 28: clocked in 09:16, never out. Their report says 08:14.
  assert.equal(theirDay('09:16').workedMinutes, 494);
});

test('a lone departure is worth the time from the shift start to it', () => {
  // Their day 21: no clock in, clocked out 17:06. Their report says 08:06.
  assert.equal(theirDay('17:06').workedMinutes, 486);
});

test('a lone punch at the normal leaving time only looks like a full day', () => {
  // Their day 1: no clock in, clocked out 17:31, reported 08:30. It reaches the full-day figure
  // only because he left on time — the same rule gave him 4:45 on day 5.
  assert.equal(theirDay('17:31').workedMinutes, 510);
});

test('a forgotten punch never earns overtime, however late the punch is', () => {
  // Forgetting to punch in must not pay better than remembering. A lone 22:00 punch is 13 hours of
  // apparent presence off a single press; the schedule caps it and none of it is overtime, because
  // the other half of the day was never measured.
  const r = theirDay('22:00');
  assert.equal(r.isMissingPunch, true);
  assert.equal(r.workedMinutes, 510, 'capped at the scheduled day, not 780');
  assert.equal(r.otMinutes, 0);
});

test('an early start is not credited on a day that is half assumption', () => {
  // 08:30 with no departure punch: the half-hour before the shift is real, but paying it while
  // inventing the entire second half of the day is not a trade worth making.
  assert.equal(theirDay('08:30').workedMinutes, 510);
});

test('the split is the scheduled midpoint, not midday', () => {
  // GENERAL is 09:30-18:30, so the midpoint is 14:00.
  const before = processDay(day({ punches: [punchAt('2026-07-15', '13:59')] }));
  assert.ok(before.checkIn, 'just before the midpoint is still an arrival');
  assert.equal(before.checkOut, null);

  const after = processDay(day({ punches: [punchAt('2026-07-15', '14:01')] }));
  assert.equal(after.checkIn, null);
  assert.ok(after.checkOut, 'just after it is a departure');
});

test('a night shift splits on its own midpoint, not the clock', () => {
  // NIGHT runs 22:00 -> 06:00, so its midpoint is 02:00 the next morning. A 23:00 punch is an
  // arrival even though it is late at night, and a 05:00 punch is a departure even though it is
  // early in the morning.
  const arrival = processDay(day({ shift: NIGHT, punches: [punchAt('2026-07-15', '23:00')] }));
  assert.ok(arrival.checkIn, 'start of a night shift');
  assert.equal(arrival.checkOut, null);

  const departure = processDay(day({ shift: NIGHT, punches: [punchAt('2026-07-15', '05:00', 1)] }));
  assert.equal(departure.checkIn, null);
  assert.ok(departure.checkOut, 'end of a night shift');
});

// ---------------------------------------------------------------------------
// Easy Time Pro's own calculation rules
//
// Read from Attendance > Global Rule > Calculation Settings. Until these were adopted, every one
// of these numbers was one we picked.
// ---------------------------------------------------------------------------

const ETP: ShiftDefinition = {
  ...GENERAL,
  halfDayMinutes: 270,          // "when work duration is less than 270 minutes, count as half day"
  missedPunchPolicy: 'present', // "calculate missed check-in / check-out as Present"
};

test("a forgotten punch is credited as Present, not as half a day", () => {
  const r = processDay(day({ shift: ETP, punches: [punchAt('2026-07-15', '09:28')] }));

  assert.equal(r.status, 'Present');
  assert.equal(r.dayFraction, 1, 'full credit — they came to work');
  assert.equal(r.isMissingPunch, true, 'still flagged, so HR can still correct it');
});

test('under our own rule the same day is still an exception at half credit', () => {
  const r = processDay(day({ punches: [punchAt('2026-07-15', '09:28')] }));

  assert.equal(r.status, 'Missing Punch');
  assert.equal(r.dayFraction, 0.5);
});

test('the half-day floor is 270 minutes, so 240 no longer earns half a day', () => {
  // 09:00 -> 14:00 is 300 gross, 240 worked after the 60m break. Under our old 240 floor that was
  // exactly half a day; under Easy Time Pro's 270 it is not enough to earn one.
  const short = processDay(
    day({ shift: ETP, punches: [punchAt('2026-07-15', '09:00'), punchAt('2026-07-15', '14:00')] })
  );
  assert.equal(short.workedMinutes, 240);
  // Not an absence: the engine keeps a short day on the register as Present and reduces the
  // payable fraction instead, because marking someone absent on a day they were demonstrably at
  // work causes more disputes than it settles.
  assert.equal(short.status, 'Present');
  assert.equal(short.dayFraction, 0.5, 'half a day of credit either way');
  assert.match(short.remarks ?? '', /Short hours/);

  // 09:00 -> 15:00 is 360 gross, 300 worked — clears 270, short of a full day.
  const half = processDay(
    day({ shift: ETP, punches: [punchAt('2026-07-15', '09:00'), punchAt('2026-07-15', '15:00')] })
  );
  assert.equal(half.workedMinutes, 300);
  assert.equal(half.status, 'Half Day');
});

test('lateness past the absence threshold is an absence, not a large late mark', () => {
  // 540 minutes past a 09:30 start, less the 15-minute grace, lands at 18:45. A 19:00 arrival is
  // 555 minutes late — clear of the threshold.
  const r = processDay(
    day({ shift: ETP, punches: [punchAt('2026-07-15', '19:00'), punchAt('2026-07-15', '20:30')] })
  );

  assert.equal(r.status, 'Absent');
  assert.equal(r.dayFraction, 0);
  assert.match(r.remarks ?? '', /beyond the absence threshold/);
});

test('ordinary lateness is unaffected by the threshold', () => {
  const r = processDay(
    day({ shift: ETP, punches: [punchAt('2026-07-15', '10:05'), punchAt('2026-07-15', '18:35')] })
  );
  assert.equal(r.isLate, true);
  assert.equal(r.lateMinutes, 20);
  assert.notEqual(r.status, 'Absent');
});

test('an early start earns overtime, as stated by the company', () => {
  // "General shift 9 to 5:30. In at 8, out at 5:30 — that is an hour of overtime."
  const shift: ShiftDefinition = {
    ...GENERAL,
    startTime: '09:00:00', endTime: '17:30:00',
    breakMinutes: 30, breakPolicy: 'fixed',
    graceInMinutes: 0, graceOutMinutes: 0,
    fullDayMinutes: 480, halfDayMinutes: 270,
    otAfterMinutes: 0, minOtMinutes: 0,
    otBasis: 'worked',
  };

  const early = processDay(
    day({ shift, punches: [punchAt('2026-07-15', '08:00'), punchAt('2026-07-15', '17:30')] })
  );
  assert.equal(early.workedMinutes, 540, '9.5 hours on site, less the 30-minute break');
  assert.equal(early.otMinutes, 60, 'the hour before the shift started');

  // The same hour at the other end is worth the same.
  const late = processDay(
    day({ shift, punches: [punchAt('2026-07-15', '09:00'), punchAt('2026-07-15', '18:30')] })
  );
  assert.equal(late.otMinutes, 60);

  // An hour at each end is two.
  const both = processDay(
    day({ shift, punches: [punchAt('2026-07-15', '08:00'), punchAt('2026-07-15', '18:30')] })
  );
  assert.equal(both.otMinutes, 120);

  // Working exactly the shift earns none.
  const exact = processDay(
    day({ shift, punches: [punchAt('2026-07-15', '09:00'), punchAt('2026-07-15', '17:30')] })
  );
  assert.equal(exact.otMinutes, 0);
});

// ---------------------------------------------------------------------------
// 'excess': the allowance is free, only an overrun is charged
//
// Stated by the company: do not decrease working hours for the break itself; only when a break
// exceeds the configured time is the excess taken off.
// ---------------------------------------------------------------------------

test("'excess' charges nothing for a break inside the allowance", () => {
  const shift = { ...GENERAL, breakMinutes: 30, breakPolicy: 'excess' as const };
  const r = processDay(
    day({
      shift,
      punches: [
        punchAt('2026-07-15', '09:00'),
        punchAt('2026-07-15', '13:00'), punchAt('2026-07-15', '13:20'), // 20m, inside 30
        punchAt('2026-07-15', '17:30'),
      ],
    })
  );
  assert.equal(r.breakMinutes, 20, 'still measured and shown');
  assert.equal(r.workedMinutes, 8 * 60 + 30, 'but nothing deducted — the whole span is worked');
});

test("'excess' charges only the minutes beyond the allowance", () => {
  const shift = { ...GENERAL, breakMinutes: 30, breakPolicy: 'excess' as const };
  const r = processDay(
    day({
      shift,
      punches: [
        punchAt('2026-07-15', '09:00'),
        punchAt('2026-07-15', '13:00'), punchAt('2026-07-15', '14:02'), // 62m, so 32 over
        punchAt('2026-07-15', '17:30'),
      ],
    })
  );
  assert.equal(r.breakMinutes, 62);
  assert.equal(r.workedMinutes, 8 * 60 + 30 - 32, 'only the 32-minute overrun');
});

test("'excess' deducts nothing when no break was punched", () => {
  // 89% of days here carry no break punch. Treating that as "took the full allowance" would dock
  // tens of thousands of hours on no evidence at all.
  const shift = { ...GENERAL, breakMinutes: 30, breakPolicy: 'excess' as const };
  const r = processDay(
    day({ shift, punches: [punchAt('2026-07-15', '09:00'), punchAt('2026-07-15', '17:30')] })
  );
  assert.equal(r.breakMinutes, 0);
  assert.equal(r.workedMinutes, 8 * 60 + 30, 'the full span is paid');
});

test("'excess' with an incomplete break under-deducts rather than over-deducts", () => {
  // Three middle punches cannot pair, so the measurement is a floor. Charging the excess of a
  // floor errs downward, which is the right direction when the data is admittedly incomplete.
  const shift = { ...GENERAL, breakMinutes: 30, breakPolicy: 'excess' as const };
  const r = processDay(
    day({
      shift,
      punches: [
        punchAt('2026-07-15', '09:00'),
        punchAt('2026-07-15', '12:00'), punchAt('2026-07-15', '13:10'), punchAt('2026-07-15', '15:00'),
        punchAt('2026-07-15', '17:30'),
      ],
    })
  );
  assert.equal(r.breaksIncomplete, true);
  assert.equal(r.breakMinutes, 70, 'the pair it could read');
  assert.equal(r.workedMinutes, 8 * 60 + 30 - 40, 'charged 40, the excess of what was measurable');
});

// ---------------------------------------------------------------------------
// the flexible shift
//
// There is no fixed start here: what is owed is the daily hours. Easy Time Pro cannot express
// that — all 163 employees sit on its General Time Table — so it graded every one of them against
// a 09:00 start and reported 1780 late days in July, 1113 hours of "lateness" that is not
// lateness under the policy the company runs. These tests pin the difference deliberately.
// ---------------------------------------------------------------------------

const flexDay = (inAt: string, outAt: string) =>
  processDay(day({
    shift: FLEXIBLE,
    punches: [punchAt('2026-07-15', inAt), punchAt('2026-07-15', outAt)],
  }));

test('arriving late is not late on a flexible shift', () => {
  // 10:30 is ninety minutes past Easy Time Pro's 09:00 and well past any grace period.
  const r = flexDay('10:30', '19:00');

  assert.equal(r.isLate, false);
  assert.equal(r.lateMinutes, 0);
  assert.equal(r.status, 'Present');
  assert.equal(r.dayFraction, 1, 'a full day: 510 minutes worked, whenever they were worked');
});

test('leaving before the shift end is not an early exit if the hours are complete', () => {
  // 07:00 -> 15:30 finishes two hours before Easy Time Pro's 17:30 and is still a full day.
  const r = flexDay('07:00', '15:30');

  assert.equal(r.isEarlyExit, false);
  assert.equal(r.earlyExitMinutes, 0);
  assert.equal(r.workedMinutes, 510);
  assert.equal(r.dayFraction, 1);
});

test('short hours are recorded but do not dock the day', () => {
  // Easy Time Pro's rule, which the company runs: attendance settles the day, hours are reported.
  // NARAYANAN CK's 4:45 day in July is counted inside his "Present: 24".
  const r = flexDay('11:00', '17:00');

  assert.equal(r.workedMinutes, 360);
  assert.equal(r.status, 'Present');
  assert.equal(r.dayFraction, 1, 'turning up settles the day');
  assert.match(r.remarks ?? '', /Short of the daily hours by 2:30/, 'but the shortfall stays visible');
  assert.equal(r.isLate, false);
});

test('a day that meets the hours carries no shortfall remark', () => {
  const r = flexDay('09:00', '17:30');

  assert.equal(r.workedMinutes, 510);
  assert.equal(r.dayFraction, 1);
  assert.doesNotMatch(r.remarks ?? '', /Short of the daily hours/);
});

test('a flexible day with no punch at all is still an absence', () => {
  // The one thing that does count against you. Without this, "never demote" would quietly pay
  // people for days they were not there.
  const r = processDay(day({ shift: FLEXIBLE }));

  assert.equal(r.status, 'Absent');
  assert.equal(r.dayFraction, 0);
});

test('overtime is measured from the hours worked, not from the shift end', () => {
  // Two days of identical length, one shifted two hours later. A schedule basis would pay the
  // second and not the first; on a flexible shift they must pay the same.
  const early = flexDay('07:00', '17:00'); // 600 minutes
  const late = flexDay('09:00', '19:00'); // 600 minutes

  assert.equal(early.workedMinutes, 600);
  assert.equal(late.workedMinutes, 600);
  assert.equal(early.otMinutes, late.otMinutes);
  assert.equal(early.otMinutes, 600 - 510 - FLEXIBLE.otAfterMinutes);
});

test('the 40-minute allowance is free, and only the overrun is charged', () => {
  // On site 09:00-18:10 with a 40-minute break punched out and back in: 550 minutes on site, and
  // the allowance costs nothing, so the day is a full one plus nothing.
  const within = processDay(day({
    shift: FLEXIBLE,
    punches: ['09:00', '13:00', '13:40', '18:10'].map((t) => punchAt('2026-07-15', t)),
  }));
  assert.equal(within.breakMinutes, 40);
  assert.equal(within.workedMinutes, 550, 'nothing deducted for a break inside the allowance');

  // The same day with a 70-minute break costs the 30 minutes of overrun.
  const over = processDay(day({
    shift: FLEXIBLE,
    punches: ['09:00', '13:00', '14:10', '18:10'].map((t) => punchAt('2026-07-15', t)),
  }));
  assert.equal(over.breakMinutes, 70);
  assert.equal(over.workedMinutes, 550 - 30);
});

test('a flexible shift never escalates a late arrival into an absence', () => {
  // Arriving at 16:00 is 420 minutes past a 09:00 start. On a fixed shift that is an absence once
  // it passes the threshold; here it is simply a short day, and the hours say so.
  const r = flexDay('16:00', '18:00');

  assert.notEqual(r.status, 'Absent');
  assert.equal(r.workedMinutes, 120);
  assert.equal(r.isLate, false);
});

test('the scheduled window still frames the day even though nobody is graded on it', () => {
  // A forgotten punch is still reconstructed against 09:00-17:30 — the window remains the frame of
  // reference for what to assume, it just stopped being a judgement.
  const r = processDay(day({ shift: FLEXIBLE, punches: [punchAt('2026-07-15', '09:16')] }));

  assert.equal(r.isMissingPunch, true);
  assert.equal(r.workedMinutes, 494, 'as Easy Time Pro reports it: 09:16 to 17:30');
  assert.equal(r.isLate, false, 'but no late mark for the 16 minutes');
});

// ---------------------------------------------------------------------------
// a day that is not over yet
//
// Somebody who punched in at 09:37 and not since has not forgotten to punch out at 10am — they are
// at work. Judging an unfinished day by the rules for a finished one got two things wrong at once:
// it put every person currently on site into the exceptions list, and it credited them to the
// shift end, booking 473 minutes at ten in the morning.
//
// asOf is what tells the two apart, and it is passed in rather than read from a clock so the
// engine stays pure — every test below fixes it explicitly.
// ---------------------------------------------------------------------------

/** 'HH:MM' on the test's work date, as an instant. */
const clockAt = (hhmm: string): Date => workDateAtTime('2026-07-15', hhmm);

const inProgress = (arrival: string, now: string) =>
  processDay(day({
    shift: FLEXIBLE,
    punches: [punchAt('2026-07-15', arrival)],
    asOf: clockAt(now),
  }));

test('mid-morning, a lone arrival is on site — not an exception', () => {
  const r = inProgress('09:37', '10:00');

  assert.equal(r.isMissingPunch, false, 'nothing has gone wrong yet');
  assert.equal(r.status, 'Present');
  assert.match(r.remarks ?? '', /has not punched out yet/);
});

test('the hours are what has been worked, not what is expected', () => {
  // The bug in one number: this used to be 473 — the whole day, at ten in the morning.
  const r = inProgress('09:37', '10:00');

  assert.equal(r.workedMinutes, 23, '09:37 to 10:00');
  assert.equal(r.otMinutes, 0, 'and no overtime on a projection');
});

test('as the day goes on the hours grow', () => {
  assert.equal(inProgress('09:00', '11:00').workedMinutes, 120);
  assert.equal(inProgress('09:00', '15:00').workedMinutes, 360);
});

test('once the shift ends it becomes a missing punch, as it always did', () => {
  // 17:30 is the scheduled end. One minute past it, the second punch is not coming.
  const r = inProgress('09:16', '17:31');

  assert.equal(r.isMissingPunch, true);
  assert.equal(r.workedMinutes, 494, 'reconstructed to the shift end, as Easy Time Pro does');
  assert.match(r.remarks ?? '', /Only one punch recorded/);
});

test('exactly at the shift end the day is over', () => {
  // The boundary is the whole rule, so it is pinned rather than left to chance.
  assert.equal(inProgress('09:16', '17:29').isMissingPunch, false, 'a minute before: still working');
  assert.equal(inProgress('09:16', '17:30').isMissingPunch, true, 'at the end: now it is missing');
});

test('a lone evening punch is a missing check-IN even mid-shift', () => {
  // Only an arrival can be "still here". A punch past the midpoint is somebody leaving, and their
  // arrival is genuinely missing whatever the time is.
  const r = processDay(day({
    shift: FLEXIBLE,
    punches: [punchAt('2026-07-15', '14:00')],
    asOf: clockAt('14:05'),
  }));

  assert.equal(r.isMissingPunch, true);
  assert.equal(r.checkIn, null);
});

test('without asOf a day is judged as finished, which is right for history', () => {
  // Every historical recompute omits it. The old behaviour has to be exactly preserved there, or
  // re-deriving last March would quietly produce different numbers than it did at the time.
  const r = processDay(day({ shift: FLEXIBLE, punches: [punchAt('2026-07-15', '09:16')] }));

  assert.equal(r.isMissingPunch, true);
  assert.equal(r.workedMinutes, 494);
});

test('the same input still produces the same result, asOf included', () => {
  const make = () => day({
    shift: FLEXIBLE, punches: [punchAt('2026-07-15', '09:37')], asOf: clockAt('10:00'),
  });
  assert.deepEqual(processDay(make()), processDay(make()));
});

// ---------------------------------------------------------------------------
// short days and long breaks
//
// On a flexible shift these are the only exceptions there are. No lateness is recorded because
// there is no fixed start; no early exit because there is no fixed end; and short hours do not
// demote the day, by policy. So somebody who worked three hours and went home was flagged as
// nothing at all — 7708 such days existed, every one of them looking like a normal full day.
// ---------------------------------------------------------------------------

const flexRange = (inAt: string, outAt: string) =>
  processDay(day({
    shift: FLEXIBLE,
    punches: [punchAt('2026-07-15', inAt), punchAt('2026-07-15', outAt)],
  }));

test('a day well under the daily hours is flagged short, though still paid in full', () => {
  // 11:00 to 17:00 is 360 minutes against a 510-minute day: 150 short.
  const r = flexRange('11:00', '17:00');

  assert.equal(r.isShortDay, true);
  assert.equal(r.dayFraction, 1, 'policy is unchanged — it still pays');
  assert.equal(r.status, 'Present');
});

test('the tolerance stops it flagging half the company every day', () => {
  // The median day here runs a few minutes over; an exact threshold would flag ordinary variation.
  assert.equal(flexRange('09:00', '17:30').isShortDay, false, 'exactly a full day');
  assert.equal(flexRange('09:00', '17:05').isShortDay, false, '25 short, inside the 30 tolerance');
  assert.equal(flexRange('09:00', '17:00').isShortDay, false, 'exactly 30 short, still inside');
  assert.equal(flexRange('09:00', '16:59').isShortDay, true, '31 short, now outside');
});

test('a break past the allowance is flagged, on either kind of shift', () => {
  // 79 minutes of break against a 40-minute allowance — Kasinath's real day.
  const over = processDay(day({
    shift: FLEXIBLE,
    punches: ['09:37', '13:23', '13:42', '18:51'].map((t) => punchAt('2026-07-15', t)),
  }));
  assert.equal(over.breakMinutes, 19);
  assert.equal(over.isLongBreak, false, '19 minutes is inside the allowance');

  const longer = processDay(day({
    shift: FLEXIBLE,
    punches: ['09:00', '12:00', '13:30', '18:00'].map((t) => punchAt('2026-07-15', t)),
  }));
  assert.equal(longer.breakMinutes, 90);
  assert.equal(longer.isLongBreak, true, '90 minutes is 50 past the allowance');
});

test('a day with no break punched is not a long break', () => {
  const r = flexRange('09:00', '17:30');
  assert.equal(r.breakMinutes, 0);
  assert.equal(r.isLongBreak, false);
});

test('an absence is not a short day — it has its own category', () => {
  const r = processDay(day({ shift: FLEXIBLE }));
  assert.equal(r.status, 'Absent');
  assert.equal(r.isShortDay, false, 'counting it twice would double every absence in the report');
});

test('a day still in progress is not short — it is unfinished', () => {
  // Somebody two hours into their day has not worked a short day yet.
  const r = processDay(day({
    shift: FLEXIBLE,
    punches: [punchAt('2026-07-15', '09:00')],
    asOf: workDateAtTime('2026-07-15', '11:00'),
  }));
  assert.equal(r.isMissingPunch, false);
  assert.equal(r.isShortDay, false);
});

test('a weekly off worked briefly is not a short day', () => {
  // Sunday: every minute is overtime and there is no requirement to fall short of.
  const r = processDay(day({
    workDate: '2026-07-19', // a Sunday
    shift: FLEXIBLE,
    punches: [punchAt('2026-07-19', '09:00'), punchAt('2026-07-19', '11:00')],
  }));
  assert.equal(r.dayType, 'weekly_off');
  assert.equal(r.isShortDay, false);
});

// ---------------------------------------------------------------------------
// an odd number of punches
//
// Reported: "if I punch for a break, punch back, then forget to punch out at home time, the time
// after the break is not calculated." True — and the day did not say so either. 09:00 / 13:00 /
// 13:30 read as a complete four-and-a-half hour day, indistinguishable from somebody who worked
// those hours and left. 618 days across the history have an odd count.
//
// Which punch is missing cannot be recovered from the record. 62% of these days have over two hours
// between the last two punches (final punch is a departure, a break-return was missed) and 28% have
// under an hour (final punch is a break-return, the departure was missed). The flag says a punch is
// missing without pretending to know which.
// ---------------------------------------------------------------------------

const oddDay = (clocks: string[]) =>
  processDay(day({ shift: FLEXIBLE, punches: clocks.map((t) => punchAt('2026-07-15', t)) }));

test('three punches is a missing punch, not a complete short day', () => {
  // The reported case: in, out for break, back from break, then home without punching.
  const r = oddDay(['09:00', '13:00', '13:30']);

  assert.equal(r.punchCount, 3);
  assert.equal(r.isMissingPunch, true, 'this is the whole fix — it used to read false');
  assert.match(r.remarks ?? '', /one stretch of the day is unaccounted for/);
});

test('five and seven punches too — any odd count means one was missed', () => {
  assert.equal(oddDay(['09:00', '11:00', '11:15', '13:00', '13:30']).isMissingPunch, true);
  assert.equal(oddDay(['09:00', '11:00', '11:15', '13:00', '13:30', '15:00', '15:20']).isMissingPunch, true);
});

test('an even count is complete and stays unflagged', () => {
  const r = oddDay(['09:00', '13:00', '13:30', '18:00']);

  assert.equal(r.isMissingPunch, false);
  assert.equal(r.breakMinutes, 30, 'the break pairs cleanly');
  assert.equal(r.workedMinutes, 540, '09:00 to 18:00, the 30-minute break inside the allowance');
});

test('the hours are deliberately unchanged — only the honesty about them is', () => {
  // Correcting the hours needs a decision about which reading to believe, and that moves money on
  // 618 days. Flagging it does not, so the flag lands first.
  const three = oddDay(['09:00', '13:00', '13:30']);
  assert.equal(three.workedMinutes, 270, 'still first punch to last');
  assert.equal(three.breaksIncomplete, true, 'and still says the break could not be measured');
});

test('a single punch keeps its own handling, which is more specific', () => {
  // One punch has its own branch: the missing side is reconstructed from the schedule. That is
  // possible there because there is only one candidate for what the punch means.
  const r = oddDay(['09:16']);
  assert.equal(r.isMissingPunch, true);
  assert.equal(r.workedMinutes, 494, 'reconstructed to the shift end, unchanged by this');
});

// --- the punch window must cover the whole day ---------------------------------------------------
//
// GENERAL is 09:00-17:30, and the window used to be schedule +/- 6h = 03:00-23:30. The next day's
// window also opened at 03:00, so 23:30-03:00 belonged to no work date and punches there were
// loaded and then dropped. Vishnu Sathyan punched at 23:34, 23:52 and 23:37 on three January days,
// each his only punch, and all three are stored Absent with zero minutes.
test('a late-evening punch belongs to the day it happened on', () => {
  const { from, to } = punchWindow('2026-07-24', GENERAL);
  const at2337 = punchAt('2026-07-24', '23:37').punchTime;
  assert.ok(at2337 >= from && at2337 < to, '23:37 must fall inside its own day');
});

test('the window leaves no gap between one day and the next', () => {
  const day1 = punchWindow('2026-07-24', GENERAL);
  const day2 = punchWindow('2026-07-25', GENERAL);
  assert.equal(day1.to.getTime(), day2.from.getTime(),
    'consecutive windows must meet exactly — a gap loses punches, an overlap double-counts them');
});

test('a punch just after midnight belongs to the evening before, not the morning after', () => {
  // The calendar-day version of this window got this wrong and it was expensive: a 00:00:35 exit
  // filed under the new date became that day's ARRIVAL, pairing with a 23:50 exit for a 23h50m day
  // and 920 minutes of overtime. Replayed over the punch history it moved 38 employee-days.
  const justAfterMidnight = punchAt('2026-07-25', '00:00').punchTime;
  const previousDay = punchWindow('2026-07-24', GENERAL);
  const thatDay = punchWindow('2026-07-25', GENERAL);

  assert.ok(
    justAfterMidnight >= previousDay.from && justAfterMidnight < previousDay.to,
    "00:00 on the 25th is the 24th's late exit"
  );
  assert.ok(
    !(justAfterMidnight >= thatDay.from && justAfterMidnight < thatDay.to),
    'and must NOT also be claimed by the 25th'
  );
});

test('an evening that runs past midnight is one day, not two half-days', () => {
  // Amal and Vishnu Sathyan work ~18:15-23:15. A night that overruns must stay whole.
  const r = processDay(day({
    workDate: '2026-07-24',
    punches: [punchAt('2026-07-24', '18:18'), punchAt('2026-07-25', '00:30')],
    shift: FLEXIBLE,
  }));
  assert.equal(r.punchCount, 2);
  assert.equal(r.workedMinutes, 372, '18:18 to 00:30 is 6h12m');
});

test('a night shift keeps its margin, so the morning exit stays on the starting day', () => {
  const { from, to } = punchWindow('2026-07-24', NIGHT);
  const exit = punchAt('2026-07-25', '05:50').punchTime;
  assert.ok(exit >= from && exit < to, "a 22:00-06:00 shift's 05:50 exit belongs to the 24th");
});

test("Amal's evening is measured, not reconstructed", () => {
  // 18:18 -> 23:37. Before the fix the exit was dropped, leaving one punch, which the
  // missing-punch branch rebuilt as 09:00-17:30 and credited 510 minutes for 319 worked.
  const r = processDay(day({
    workDate: '2026-07-24',
    punches: [punchAt('2026-07-24', '18:18'), punchAt('2026-07-24', '23:37')],
    shift: FLEXIBLE,
  }));
  // FLEXIBLE, not GENERAL: the live shift charges only break beyond its allowance, and no break was
  // punched here, so the whole 18:18-23:37 span stands. GENERAL deducts a flat hour and would have
  // tested the break policy rather than the window.
  assert.equal(r.punchCount, 2, 'the 23:37 exit must survive — it used to be dropped');
  assert.equal(r.workedMinutes, 319);
  assert.equal(r.isMissingPunch, false, 'both ends are present');
});

// --- exceptions are recorded on a day off too ----------------------------------------------------
test('an odd punch count on a weekly off is flagged, not silently paid as overtime', () => {
  const punches = [
    punchAt('2026-07-26', '09:00'), punchAt('2026-07-26', '13:00'), punchAt('2026-07-26', '17:00'),
  ];
  const r = processDay(day({ workDate: '2026-07-26', punches, shift: GENERAL }));
  assert.equal(r.dayType, 'weekly_off');
  assert.ok(r.otMinutes > 0, 'still paid — every minute on a day off is overtime');
  assert.equal(r.isMissingPunch, true, 'and now says the record is incomplete');
});

test('a long break on a weekly off is flagged, since its excess was deducted from the paid OT', () => {
  const punches = [
    punchAt('2026-07-26', '09:00'), punchAt('2026-07-26', '12:00'),
    punchAt('2026-07-26', '13:30'), punchAt('2026-07-26', '18:00'),
  ];
  const r = processDay(day({ workDate: '2026-07-26', punches, shift: GENERAL }));
  assert.equal(r.breakMinutes, 90);
  assert.equal(r.isLongBreak, true);
});

test('a lone punch on a day off credits nothing, but says so', () => {
  const r = processDay(day({
    workDate: '2026-07-26', punches: [punchAt('2026-07-26', '10:00')], shift: GENERAL,
  }));
  assert.equal(r.workedMinutes, 0, 'nothing to measure, and no schedule to invent one from');
  assert.equal(r.otMinutes, 0);
  assert.equal(r.isMissingPunch, true, 'the day must not look like an ordinary rest day');
});
