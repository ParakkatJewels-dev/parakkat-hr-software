import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processDay, scheduledBreakWindows } from './processDay';
import { workDateAtTime } from '../lib/time';
import type { DayInput, ShiftDefinition } from './types';

const DAY: ShiftDefinition = {
  id: 'scheduled-day', code: 'DAY', name: 'Scheduled breaks', startTime: '09:00:00', endTime: '17:30:00',
  crossesMidnight: false, graceInMinutes: 0, graceOutMinutes: 0,
  breakMinutes: 0, breakPolicy: 'scheduled', weeklyOffs: [],
  breakWindows: [
    { label: 'Tea', startTime: '11:00', endTime: '11:15', isPaid: true },
    { label: 'Lunch', startTime: '13:00', endTime: '13:30', isPaid: false },
  ],
  fullDayMinutes: 480, halfDayMinutes: 240, otAfterMinutes: 0, minOtMinutes: 30,
  missedPunchPolicy: 'exception', lateAbsentMinutes: 1440, earlyAbsentMinutes: 1440,
  shortDayToleranceMinutes: 30, otBasis: 'worked', isFlexible: false,
};
const workDate = '2026-07-14';
function input(times: string[], overrides: Partial<DayInput> = {}): DayInput {
  return {
    employeeId: 'fixture-employee', workDate, shift: DAY, dayType: 'working', holidayName: null,
    punches: times.map((time, index) => ({ id: BigInt(index + 1),
      punchTime: workDateAtTime(workDate, time), punchState: null, terminalSn: null, terminalAlias: null })),
    leave: null, regularization: null, ...overrides,
  };
}

test('scheduled unpaid lunch is deducted without break punches while paid tea costs nothing', () => {
  const result = processDay(input(['09:00', '17:30']));
  assert.equal(result.workedMinutes, 480);
  assert.equal(result.breakMinutes, 0, 'raw measured break evidence stays separate from scheduled deductions');
  assert.equal(result.isLongBreak, false);
  assert.equal(result.isMissingPunch, false);
});

test('measured paid and unpaid scheduled breaks are never deducted twice', () => {
  const result = processDay(input(['09:00', '11:00', '11:15', '13:00', '13:30', '17:30']));
  assert.equal(result.workedMinutes, 480);
  assert.equal(result.breakMinutes, 45);
  assert.equal(result.isLongBreak, false);
});

test('time away outside a paid window is deducted and flagged', () => {
  const result = processDay(input(['09:00', '10:50', '11:20', '17:30']));
  assert.equal(result.workedMinutes, 465, '30-minute unpaid lunch plus 15 minutes outside paid tea');
  assert.equal(result.breakMinutes, 30);
  assert.equal(result.isLongBreak, true);
});

test('one measured interval spanning adjacent paid and unpaid windows uses their union', () => {
  const shift: ShiftDefinition = { ...DAY, breakWindows: [
    { label: 'Paid', startTime: '12:00', endTime: '12:15', isPaid: true },
    { label: 'Unpaid', startTime: '12:15', endTime: '12:45', isPaid: false },
  ] };
  const result = processDay(input(['09:00', '11:50', '13:00', '17:30'], { shift }));
  assert.equal(result.workedMinutes, 455, '510 minus 30 unpaid and 25 measured outside both windows');
});

test('partial attendance deducts only the intersecting part of an unpaid break', () => {
  assert.equal(processDay(input(['14:00', '17:30'])).workedMinutes, 210);
  assert.equal(processDay(input(['13:15', '17:30'])).workedMinutes, 240);
  assert.equal(processDay(input(['09:00', '13:15'])).workedMinutes, 240);
});

test('in-progress and missing-punch days use their actual or reconstructed interval', () => {
  const beforeLunch = processDay(input(['09:00'], { asOf: workDateAtTime(workDate, '12:00') }));
  assert.equal(beforeLunch.workedMinutes, 180);
  assert.equal(beforeLunch.isMissingPunch, false);
  assert.equal(processDay(input(['09:00'], { asOf: workDateAtTime(workDate, '13:15') })).workedMinutes, 240);
  const missing = processDay(input(['09:00']));
  assert.equal(missing.workedMinutes, 480);
  assert.equal(missing.isMissingPunch, true);
  assert.equal(processDay(input(['14:00'], { regularization: { id: 'arrival', checkIn: workDateAtTime(workDate, '14:00'), checkOut: null } })).workedMinutes, 210);
  assert.equal(processDay(input(['12:00'], { regularization: { id: 'departure', checkIn: null, checkOut: workDateAtTime(workDate, '12:00') } })).workedMinutes, 180);
});

test('incomplete measured breaks remain flagged instead of being repaired by the timetable', () => {
  const result = processDay(input(['09:00', '13:00', '17:30']));
  assert.equal(result.workedMinutes, 480);
  assert.equal(result.breaksIncomplete, true);
  assert.equal(result.isMissingPunch, true);
});

test('a corrected checkout retains measured outside-window time and scheduled break deductions', () => {
  const result = processDay(input(['09:00', '10:50', '11:20'], {
    regularization: { id: 'approved', checkIn: null, checkOut: workDateAtTime(workDate, '17:30') },
  }));
  assert.equal(result.workedMinutes, 465);
  assert.equal(result.breakMinutes, 30);
  assert.equal(result.breaksIncomplete, false);
  assert.equal(result.isMissingPunch, false);
});

test('overnight breaks resolve both crossing midnight and after-midnight clocks on the starting shift', () => {
  const shift: ShiftDefinition = { ...DAY, startTime: '22:00:00', endTime: '06:00:00', crossesMidnight: true,
    fullDayMinutes: 450, breakWindows: [
      { label: 'Paid tea', startTime: '23:45', endTime: '00:15', isPaid: true },
      { label: 'Night meal', startTime: '02:00', endTime: '02:30', isPaid: false },
    ] };
  const dates = ['22:00', '23:45', '00:15', '02:00', '02:30', '06:00'];
  const result = processDay(input([], { shift, punches: dates.map((time, index) => ({
    id: BigInt(index + 1), punchTime: workDateAtTime(workDate, time, index >= 2 ? 1 : 0),
    punchState: null, terminalSn: null, terminalAlias: null,
  })) }));
  assert.equal(result.workedMinutes, 450);
  assert.equal(result.breakMinutes, 60);
  assert.equal(result.isLongBreak, false);
  assert.equal(scheduledBreakWindows(workDate, shift)[1]!.from.getTime(), workDateAtTime(workDate, '02:00', 1).getTime());
});

test('scheduled break configuration rejects empty, overlapping, invalid and out-of-shift windows', () => {
  assert.throws(() => scheduledBreakWindows(workDate, { ...DAY, breakWindows: [] }), /between 1 and 16/);
  assert.throws(() => scheduledBreakWindows(workDate, { ...DAY, breakWindows: [
    { label: 'Lunch', startTime: '13:00', endTime: '14:00', isPaid: false },
    { label: 'Tea', startTime: '13:45', endTime: '14:15', isPaid: true },
  ] }), /must not overlap/);
  for (const [startTime, endTime] of [['08:00', '08:30'], ['17:00', '18:00'], ['13:00', '13:00']]) {
    assert.throws(() => scheduledBreakWindows(workDate, { ...DAY, breakWindows: [
      { label: 'Invalid', startTime: startTime!, endTime: endTime!, isPaid: false },
    ] }), /fit inside/);
  }
  assert.throws(() => scheduledBreakWindows(workDate, { ...DAY, breakWindows: [
    { label: 'Invalid', startTime: '25:00', endTime: '25:30', isPaid: false },
  ] }), /invalid scheduled break/);
});

test('configured clock windows do not change existing break policies', () => {
  const times = ['09:00', '10:50', '11:20', '17:30'];
  for (const [breakPolicy, expected] of [['fixed', 470], ['actual', 480], ['actual_over_allowance', 470], ['excess', 510]] as const) {
    assert.equal(processDay(input(times, { shift: { ...DAY, breakPolicy, breakMinutes: 40 } })).workedMinutes, expected);
  }
});
