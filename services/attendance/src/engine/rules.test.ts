// Rule tests for the attendance engine.
//
//   npx tsx --test src/engine/rules.test.ts
//
// processDay is pure, so every rule is exercised without a database or a BioTime connection.
// The four edge cases the brief calls out each have a test here, because they are exactly the
// ones that produce plausible-looking wrong numbers rather than obvious errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processDay, dedupePunches, punchWindow } from './processDay';
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
  assert.equal(r.workedMinutes, 0);
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

test('working on a weekly off makes the whole day overtime', () => {
  const r = processDay(
    day({
      workDate: '2026-07-19',
      punches: [punchAt('2026-07-19', '10:00'), punchAt('2026-07-19', '15:00')],
    })
  );

  assert.equal(r.status, 'Weekly Off');
  assert.equal(r.otMinutes, 240); // 5h on site, minus the 60m break
  assert.match(r.remarks ?? '', /Worked on weekly off/);
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
