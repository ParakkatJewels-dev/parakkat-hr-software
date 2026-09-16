import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attendanceTimeline } from './attendanceTimeline.js';
import { explainDay, insideMinutes, onSiteMinutes } from './attendanceSummary.js';

const at = clock => `2026-07-15T${clock}:00+05:30`;
const corrected = (punches, checkIn, checkOut) => ({
  regularization_id: 'approved', punches: punches.map(at), check_in: checkIn && at(checkIn), check_out: checkOut && at(checkOut),
});

test('ATT-01 and ATT-02: UI timelines include approved missing endpoints and preserve raw evidence', () => {
  const arrival = corrected(['16:30'], '09:00', '16:30');
  assert.deepEqual(attendanceTimeline(arrival), ['09:00', '16:30'].map(at));
  const departure = corrected(['09:00', '12:00', '13:30'], '09:00', '17:30');
  assert.deepEqual(attendanceTimeline(departure), ['09:00', '12:00', '13:30', '17:30'].map(at));
  assert.deepEqual(departure.punches, ['09:00', '12:00', '13:30'].map(at));
  const missingArrival = corrected(['12:00', '13:30', '17:30'], '09:00', '17:30');
  assert.deepEqual(attendanceTimeline(missingArrival), attendanceTimeline(departure));
});

test('explicit overrides replace complete-day endpoints while ambiguous interior punches remain', () => {
  assert.deepEqual(attendanceTimeline(corrected(['09:00', '12:00', '13:30', '17:30'], '09:10', '17:40')),
    ['09:10', '12:00', '13:30', '17:40'].map(at));
  assert.deepEqual(attendanceTimeline(corrected(['12:00'], '09:00', '17:30')), ['09:00', '12:00', '17:30'].map(at));
  assert.deepEqual(attendanceTimeline(corrected([], '09:00', '17:30')), ['09:00', '17:30'].map(at));
});

test('schedule reconstructions never appear as approved timeline endpoints', () => {
  const row = { punches: [at('09:00')], check_in: at('09:00'), check_out: at('17:30') };
  assert.deepEqual(attendanceTimeline(row), [at('09:00')]);
  assert.equal(onSiteMinutes(row), null);
  assert.equal(insideMinutes(row), null);
});

test('ATT-02: detailed hours and break ledger reconcile to approved attendance output', () => {
  const row = { ...corrected(['09:00', '12:00', '13:30'], '09:00', '17:30'),
    break_minutes: 90, worked_minutes: 460, breaks_incomplete: false };
  assert.equal(onSiteMinutes(row), 510);
  assert.equal(insideMinutes(row), 420);
  const explanation = explainDay(row, { break_minutes: 40 });
  assert.match(explanation.lines[0].label, /approved corrections included/);
  assert.deepEqual(explanation.lines.map(line => line.minutes), [510, -90, 420, 40, 460]);
  assert.equal(explanation.incomplete, false);
});
