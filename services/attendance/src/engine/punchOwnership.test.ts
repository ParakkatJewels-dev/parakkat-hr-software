import { test } from 'node:test';
import assert from 'node:assert/strict';
import { punchBoundary, punchWindow } from './processDay';
import { workDateAtTime } from '../lib/time';
import type { ShiftDefinition } from './types';

const DAY: ShiftDefinition = {
  id: 'day', code: 'DAY', name: 'Day', startTime: '09:00:00', endTime: '17:30:00',
  crossesMidnight: false, graceInMinutes: 0, graceOutMinutes: 0,
  breakMinutes: 30, breakPolicy: 'excess', weeklyOffs: [],
  fullDayMinutes: 510, halfDayMinutes: 255, otAfterMinutes: 0, minOtMinutes: 30,
  missedPunchPolicy: 'exception', lateAbsentMinutes: 1440, earlyAbsentMinutes: 1440,
  shortDayToleranceMinutes: 30, otBasis: 'worked', isFlexible: false,
};
const LATER_DAY = { ...DAY, id: 'later', code: 'LATER', startTime: '09:30:00', endTime: '18:00:00' };
const NIGHT = { ...DAY, id: 'night', code: 'NIGHT', startTime: '22:00:00', endTime: '06:00:00', crossesMidnight: true };
const owns = (window: { from: Date; to: Date }, punch: Date) => punch >= window.from && punch < window.to;
const at = (day: string, time: string) => workDateAtTime(day, time).getTime();

test('regular day and night shifts retain their start-minus-six-hours boundary', () => {
  assert.equal(punchWindow('2026-07-14', DAY).from.getTime(), at('2026-07-14', '03:00'));
  assert.equal(punchWindow('2026-07-14', DAY).to.getTime(), at('2026-07-15', '03:00'));
  assert.equal(punchWindow('2026-07-14', NIGHT).from.getTime(), at('2026-07-14', '16:00'));
  assert.equal(punchWindow('2026-07-14', NIGHT).to.getTime(), at('2026-07-15', '16:00'));
});

test('a 09:00 to 09:30 schedule change neither loses nor double-counts the half-hour between cutovers', () => {
  const before = punchWindow('2026-07-14', DAY, { previous: DAY, next: LATER_DAY });
  const after = punchWindow('2026-07-15', LATER_DAY, { previous: DAY, next: LATER_DAY });
  assert.equal(before.to.getTime(), at('2026-07-15', '03:30'));
  assert.equal(before.to.getTime(), after.from.getTime());
  for (const time of ['03:00', '03:15', '03:29']) {
    const punch = workDateAtTime('2026-07-15', time);
    assert.equal(owns(before, punch), true);
    assert.equal(owns(after, punch), false);
  }
  assert.equal(owns(before, after.from), false);
  assert.equal(owns(after, after.from), true);
  assert.equal(punchBoundary('2026-07-15', LATER_DAY, DAY).getTime(), at('2026-07-15', '03:00'));
});

test('a night-to-day rotation separates the morning checkout and next arrival at the midpoint', () => {
  const night = punchWindow('2026-07-14', NIGHT, { previous: NIGHT, next: DAY });
  const day = punchWindow('2026-07-15', DAY, { previous: NIGHT, next: DAY });
  assert.equal(night.to.getTime(), at('2026-07-15', '07:30'));
  assert.equal(night.to.getTime(), day.from.getTime());
  assert.equal(owns(night, workDateAtTime('2026-07-15', '06:00')), true);
  assert.equal(owns(day, workDateAtTime('2026-07-15', '06:00')), false);
  assert.equal(owns(night, workDateAtTime('2026-07-15', '09:00')), false);
  assert.equal(owns(day, workDateAtTime('2026-07-15', '09:00')), true);
});

test('day-to-night rotation retains the next night start-minus-six-hours cutover', () => {
  assert.equal(punchBoundary('2026-07-15', DAY, NIGHT).getTime(), at('2026-07-15', '16:00'));
});

test('a preferred boundary exactly at the previous checkout moves into the gap', () => {
  const earlierNight = { ...NIGHT, endTime: '03:00:00' };
  const previous = punchWindow('2026-07-14', earlierNight, { previous: earlierNight, next: DAY });
  assert.equal(previous.to.getTime(), at('2026-07-15', '06:00'));
  assert.equal(owns(previous, workDateAtTime('2026-07-15', '03:00')), true);
});

test('long repeating night shifts share a midpoint instead of overlapping their margins', () => {
  const longNight = { ...NIGHT, startTime: '20:00:00', endTime: '15:00:00' };
  const first = punchWindow('2026-07-14', longNight);
  const next = punchWindow('2026-07-15', longNight);
  assert.equal(first.to.getTime(), at('2026-07-15', '17:30'));
  assert.equal(first.to.getTime(), next.from.getTime());
  assert.equal(owns(first, workDateAtTime('2026-07-15', '15:00')), true);
  assert.equal(owns(next, workDateAtTime('2026-07-15', '20:00')), true);
});

test('month and year boundaries use the same adjacent assignment rule', () => {
  const previous = punchWindow('2026-12-31', NIGHT, { previous: NIGHT, next: LATER_DAY });
  const current = punchWindow('2027-01-01', LATER_DAY, { previous: NIGHT, next: LATER_DAY });
  assert.equal(previous.to.getTime(), at('2027-01-01', '07:45'));
  assert.equal(previous.to.getTime(), current.from.getTime());
});

test('night-to-missing and missing-to-night assignments retain one owner for every boundary punch', () => {
  const before = punchWindow('2026-07-14', NIGHT, { previous: NIGHT, next: null });
  const missing = punchWindow('2026-07-15', null, { previous: NIGHT, next: NIGHT });
  const after = punchWindow('2026-07-16', NIGHT, { previous: null, next: NIGHT });
  assert.equal(before.to.getTime(), at('2026-07-15', '12:00'));
  assert.equal(before.to.getTime(), missing.from.getTime());
  assert.equal(missing.to.getTime(), at('2026-07-16', '16:00'));
  assert.equal(missing.to.getTime(), after.from.getTime());
  assert.equal(owns(before, workDateAtTime('2026-07-15', '06:00')), true);
  for (let instant = before.from.getTime(); instant < after.to.getTime(); instant += 60_000) {
    assert.equal([before, missing, after].filter(window => owns(window, new Date(instant))).length, 1);
  }
});

test('day-to-missing keeps a post-midnight checkout, while wholly unassigned dates remain calendar days', () => {
  assert.equal(punchBoundary('2026-07-15', DAY, null).getTime(), at('2026-07-15', '03:00'));
  const missing = punchWindow('2026-07-15', null);
  assert.equal(missing.from.getTime(), at('2026-07-15', '00:00'));
  assert.equal(missing.to.getTime(), at('2026-07-16', '00:00'));
});

test('overlapping or touching schedules are rejected instead of guessing a punch owner', () => {
  assert.throws(() => punchBoundary('2026-07-15', { ...NIGHT, endTime: '10:00:00' }, DAY), /Overlapping shift schedules/);
  assert.throws(() => punchBoundary('2026-07-15', NIGHT, { ...DAY, startTime: '06:00:00' }), /Overlapping shift schedules/);
});

test('an inverted missing-day boundary and a 24-hour shift require corrected assignments', () => {
  assert.throws(() => punchWindow('2026-07-15', null, {
    previous: { ...NIGHT, startTime: '23:00:00', endTime: '22:00:00' },
    next: { ...DAY, startTime: '01:00:00', endTime: '09:00:00' },
  }), /Conflicting shift punch boundaries/);
  assert.throws(() => punchWindow('2026-07-15', { ...NIGHT, endTime: '22:00:00' }, { previous: null, next: null }), /shorter than 24 hours/);
});
