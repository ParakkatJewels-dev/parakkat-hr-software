import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordedPunches, firstRecordedPunch, latestRecordedPunch, punchDate } from './recordedPunches.js';

const at = time => `2026-09-18T${time}:00+05:30`;
test('a break and return keep the original arrival and every punch in order', () => {
  const row = { punches: ['10:10', '09:00', '10:00'].map(at), check_in: at('10:10') };
  assert.equal(firstRecordedPunch(row), at('09:00'));
  assert.equal(latestRecordedPunch(row), at('10:10'));
  assert.deepEqual(recordedPunches(row), ['09:00', '10:00', '10:10'].map(at));
  assert.equal(row.punches[0], at('10:10'), 'do not mutate the attendance cache');
  row.punches.push(at('18:00'));
  assert.equal(firstRecordedPunch(row), at('09:00'));
  assert.equal(recordedPunches(row).length, 4);
});

test('approved and reconstructed times never replace device evidence', () => {
  assert.deepEqual(recordedPunches({ punches: [at('09:00')], check_in: at('08:45'), check_out: at('18:00'), regularization_id: 'approved' }), [at('09:00')]);
  assert.deepEqual(recordedPunches({ check_in: at('09:00'), check_out: at('18:00') }), []);
  assert.deepEqual(recordedPunches({ first_punch_at: at('09:00'), last_punch_at: at('10:10') }), ['09:00', '10:10'].map(at));
});

test('invalid and duplicate timestamps are ignored; overnight punches retain their IST date', () => {
  assert.deepEqual(recordedPunches({ punches: [null, 'invalid', at('09:00'), '2026-09-18T03:30:00Z'] }), ['2026-09-18T03:30:00Z']);
  assert.equal(punchDate('2026-09-18T20:30:00Z'), '2026-09-19');
});
