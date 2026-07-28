// The translation from Easy Time Pro's vocabulary into ours, tested without a terminal.
//
//   npx tsx --test src/scripts/shiftFromDevice.test.ts
//
// This is the part worth testing: a misread grace period silently relabels people as late for
// months, and a misread rest_time changes everyone's paid hours. Field names differ between
// Easy Time Pro builds, so each case below is a shape a real build is known to return.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asClock, addMinutes, mapRecord } from '../sync/shiftMapping';

test('clock values are accepted in every shape a build might send', () => {
  assert.equal(asClock('09:30:00'), '09:30:00');
  assert.equal(asClock('9:30'), '09:30:00');
  assert.equal(asClock('09:30'), '09:30:00');
  assert.equal(asClock(570), '09:30:00', 'minutes past midnight');
  assert.equal(asClock(0), '00:00:00');
  assert.equal(asClock('nonsense'), undefined, 'refuses rather than guessing');
  assert.equal(asClock(undefined), undefined);
});

test('an end time derived from a duration crosses midnight correctly', () => {
  assert.equal(addMinutes('09:30:00', 480), '17:30:00');
  assert.equal(addMinutes('22:00:00', 480), '06:00:00', 'night shift wraps');
  assert.equal(addMinutes('09:30:00', 0), '09:30:00');
});

test('a start-plus-duration record yields both times', () => {
  // The common BioTime 8 shape: in_time and work_time_duration, no explicit out_time.
  const m = mapRecord(
    { id: 1, alias: 'General', in_time: '09:30:00', work_time_duration: 480,
      rest_time: 60, use_rest_time: true, late_in: 15, early_out: 15, min_ot: 30 },
    '/att/api/timeIntervals/'
  );
  assert.equal(m.name, 'General');
  assert.equal(m.startTime, '09:30:00');
  assert.equal(m.endTime, '17:30:00', 'derived from the duration');
  assert.equal(m.breakMinutes, 60);
  assert.equal(m.graceIn, 15);
  assert.equal(m.graceOut, 15);
  assert.equal(m.minOt, 30);
  assert.deepEqual(m.unread, []);
});

test('a break that is configured but not deducted counts as zero', () => {
  // use_rest_time false means the hour exists on paper and is never taken off worked time.
  // Reading rest_time regardless would quietly shorten everybody's day by an hour.
  const m = mapRecord({ alias: 'X', in_time: '09:00', out_time: '17:00', rest_time: 60, use_rest_time: false }, 'p');
  assert.equal(m.breakMinutes, 0);

  const on = mapRecord({ alias: 'X', in_time: '09:00', out_time: '17:00', rest_time: 60, use_rest_time: true }, 'p');
  assert.equal(on.breakMinutes, 60);
});

test('alternative field spellings are all understood', () => {
  const m = mapRecord(
    { name: 'Shift B', start_time: '10:00:00', end_time: '19:00:00',
      break_time: 45, in_above_margin: 10, out_ahead_margin: 20 },
    'p'
  );
  assert.equal(m.name, 'Shift B');
  assert.equal(m.startTime, '10:00:00');
  assert.equal(m.endTime, '19:00:00');
  assert.equal(m.breakMinutes, 45);
  assert.equal(m.graceIn, 10);
  assert.equal(m.graceOut, 20);
});

test('unrecognised fields are reported, never silently dropped', () => {
  const m = mapRecord({ alias: 'X', in_time: '09:00', out_time: '17:00', some_new_flag: 7 }, 'p');
  assert.deepEqual(m.unread, ['some_new_flag'],
    'a field nobody has mapped must be visible, so a real setting is not missed');
});

test('a record with no usable times reports nothing rather than a default', () => {
  const m = mapRecord({ alias: 'Broken', use_mode: 1 }, 'p');
  assert.equal(m.startTime, undefined);
  assert.equal(m.endTime, undefined);
  assert.equal(m.graceIn, undefined, 'absent is absent, not zero');
});
