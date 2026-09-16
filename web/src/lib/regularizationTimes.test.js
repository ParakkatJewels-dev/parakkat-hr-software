import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correctionDateLabel, regularizationTimes } from './regularizationTimes.js';

test('same-day corrections retain IST timestamps in every browser timezone', () => {
  const previous = process.env.TZ;
  try {
    for (const timezone of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles']) {
      process.env.TZ = timezone;
      assert.deepEqual(regularizationTimes({ workDate: '2026-07-15', checkIn: '09:00', checkOut: '17:30' }), {
        checkIn: '2026-07-15T03:30:00.000Z', checkOut: '2026-07-15T12:00:00.000Z',
      });
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('ATT-05: explicit overnight corrections use the following date for departure', () => {
  assert.deepEqual(regularizationTimes({
    workDate: '2026-07-15', checkIn: '22:00', checkOut: '06:00', checkOutNextDay: true,
  }), { checkIn: '2026-07-15T16:30:00.000Z', checkOut: '2026-07-16T00:30:00.000Z' });
});

test('ATT-05: next-day exit works without a check-in and across year boundaries', () => {
  assert.deepEqual(regularizationTimes({
    workDate: '2026-12-31', checkOut: '06:00', checkOutNextDay: true,
  }), { checkIn: null, checkOut: '2027-01-01T00:30:00.000Z' });
});

test('invalid or ambiguous timestamps fail before a correction can be inserted', () => {
  for (const workDate of ['2026-02-29', '2026-13-01', 'invalid', '']) {
    assert.throws(() => regularizationTimes({ workDate, checkIn: '09:00' }), /valid work date/);
  }
  for (const checkOut of ['24:00', '6:00', '12:99']) {
    assert.throws(() => regularizationTimes({ workDate: '2026-07-15', checkOut }), /valid time/);
  }
  assert.throws(() => regularizationTimes({ workDate: '2026-07-15' }), /Enter a check-in/);
  for (const checkOut of ['06:00', '22:00']) {
    assert.throws(() => regularizationTimes({ workDate: '2026-07-15', checkIn: '22:00', checkOut }), /next day/);
  }
});

test('review labels reveal overnight exits using the IST date', () => {
  assert.equal(correctionDateLabel('2026-07-15T12:00:00.000Z', '2026-07-15'), '');
  assert.equal(correctionDateLabel('2026-07-15T19:00:00.000Z', '2026-07-15'), ' (2026-07-16)');
  assert.equal(correctionDateLabel(null, '2026-07-15'), '');
});
