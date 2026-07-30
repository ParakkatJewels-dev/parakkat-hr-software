// Formatting a time of day in both shapes.
//
//   npm test
//
// The app previously did this six ways and disagreed with itself inside one component, so the point
// of these is that one function answers for every screen — and that it never quietly shifts a punch
// into the reader's own timezone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatClock, formatMinutesOfDay, CLOCK_FORMATS } from './clock.js';

const ist = (t) => `2026-07-29T${t}:00+05:30`;

test('24-hour is zero-padded, so a column of times lines up', () => {
  assert.equal(formatClock(ist('09:37')), '09:37');
  assert.equal(formatClock(ist('18:51')), '18:51');
  assert.equal(formatClock(ist('00:05')), '00:05');
});

test('12-hour is not padded, because "09:37 am" reads like a typo', () => {
  assert.equal(formatClock(ist('09:37'), true), '9:37 am');
  assert.equal(formatClock(ist('18:51'), true), '6:51 pm');
});

test('noon and midnight, the two that catch every clock', () => {
  assert.equal(formatClock(ist('12:00'), true), '12:00 pm');
  assert.equal(formatClock(ist('00:00'), true), '12:00 am');
  assert.equal(formatClock(ist('12:00')), '12:00');
  assert.equal(formatClock(ist('00:00')), '00:00');
});

test('the punch stays on IST whatever timezone the reader is in', () => {
  // The failure this prevents: an owner checking the roster from abroad sees every punch shifted.
  const before = process.env.TZ;
  for (const tz of ['UTC', 'America/New_York', 'Asia/Tokyo', 'Asia/Kolkata']) {
    process.env.TZ = tz;
    assert.equal(formatClock(ist('09:37')), '09:37', tz);
    assert.equal(formatClock(ist('09:37'), true), '9:37 am', tz);
  }
  process.env.TZ = before;
});

test('minutes past midnight format the same way', () => {
  assert.equal(formatMinutesOfDay(577), '09:37');
  assert.equal(formatMinutesOfDay(577, true), '9:37 am');
  assert.equal(formatMinutesOfDay(720, true), '12:00 pm');
  assert.equal(formatMinutesOfDay(0, true), '12:00 am');
  assert.equal(formatMinutesOfDay(1439), '23:59');
});

test('minutes outside a day wrap rather than printing nonsense', () => {
  assert.equal(formatMinutesOfDay(1440), '00:00', 'exactly midnight tomorrow');
  assert.equal(formatMinutesOfDay(1500), '01:00');
  assert.equal(formatMinutesOfDay(-60), '23:00', 'an hour before midnight');
});

test('nothing in gives an em dash, not "Invalid Date"', () => {
  for (const bad of [null, undefined, '', 'not a date']) {
    assert.equal(formatClock(bad), '—', String(bad));
  }
  assert.equal(formatMinutesOfDay(null), '—');
  assert.equal(formatMinutesOfDay(undefined), '—');
});

test('the settings control has both choices, with an example of each', () => {
  assert.equal(CLOCK_FORMATS.length, 2);
  for (const f of CLOCK_FORMATS) {
    assert.ok(f.label && f.example && f.key);
    // The example must be what the formatter really produces, or the setting lies about itself.
    assert.equal(formatClock(ist('17:30'), f.value), f.example);
  }
});
