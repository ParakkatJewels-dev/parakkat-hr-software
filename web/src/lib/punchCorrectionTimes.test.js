import { test } from 'node:test';
import assert from 'node:assert/strict';
import { punchCorrectionEndpointEvidence, punchCorrectionTimes } from './punchCorrectionTimes.js';

function context(workDate, checkIn, checkOut) {
  return { employee_id: 'employee', work_date: workDate, attendance: {
    employee_id: 'employee', work_date: workDate, check_in: checkIn, check_out: checkOut,
    first_punch_at: checkIn, last_punch_at: checkOut, punches: [checkIn, checkOut].filter(Boolean),
  }, raw_punches: [checkIn, checkOut].filter(Boolean).map(punch_time => ({ punch_time })) };
}

test('same-minute check-ins keep their recorded seconds and changed checkout uses the entered minute', () => {
  for (const [workDate, clock, exact, out] of [
    ['2026-09-02', '09:22', '09:22:09', '19:45'],
    ['2026-09-17', '09:16', '09:16:46', '18:21'],
  ]) {
    const recorded = `${workDate}T${exact}+05:30`;
    const evidence = context(workDate, recorded, `${workDate}T17:35:09+05:30`);
    const times = punchCorrectionTimes({ workDate, checkIn: clock, checkOut: out,
      endpointEvidence: punchCorrectionEndpointEvidence(evidence) });
    assert.equal(times.checkIn, recorded);
    assert.equal(times.checkOut, new Date(`${workDate}T${out}:00+05:30`).toISOString());
  }
});

test('changed minutes and blank device-fallback endpoints are never filled from retained evidence', () => {
  const endpointEvidence = { checkIn: '2026-09-02T09:22:09+05:30', checkOut: '2026-09-02T19:45:47+05:30' };
  assert.deepEqual(punchCorrectionTimes({ workDate: '2026-09-02', checkIn: '09:23', checkOut: '', endpointEvidence }),
    { checkIn: '2026-09-02T03:53:00.000Z', checkOut: null });
  assert.deepEqual(punchCorrectionTimes({ workDate: '2026-09-02', checkIn: '', checkOut: '19:45', endpointEvidence }),
    { checkIn: null, checkOut: endpointEvidence.checkOut });
  assert.throws(() => punchCorrectionTimes({ workDate: '2026-09-02', checkIn: '', checkOut: '', endpointEvidence }), /check-in or check-out/);
});

test('an approved endpoint retains its exact timestamp before recomputation and takes precedence over raw punches', () => {
  const evidence = context('2026-09-17', '2026-09-17T09:16:46+05:30', '2026-09-17T17:35:09+05:30');
  evidence.active_correction = { status: 'Approved', check_in: '2026-09-17T09:20:27.123456+05:30', check_out: '2026-09-17T18:21:52+05:30' };
  const endpointEvidence = punchCorrectionEndpointEvidence(evidence);
  assert.deepEqual(punchCorrectionTimes({ workDate: '2026-09-17', checkIn: '09:20', checkOut: '18:21', endpointEvidence }),
    { checkIn: evidence.active_correction.check_in, checkOut: evidence.active_correction.check_out });
  assert.equal(punchCorrectionTimes({ workDate: '2026-09-17', checkIn: '09:16', checkOut: '', endpointEvidence }).checkIn,
    '2026-09-17T03:46:00.000Z', 'changing the approved minute remains an explicit edit');
  evidence.active_correction.status = 'Pending';
  assert.equal(punchCorrectionEndpointEvidence(evidence).checkIn, evidence.attendance.check_in);
});

test('overnight preservation matches the actual endpoint date, not just its clock time', () => {
  const evidence = context('2026-09-15', '2026-09-15T22:00:17+05:30', '2026-09-16T06:00:41+05:30');
  const endpointEvidence = punchCorrectionEndpointEvidence(evidence);
  assert.deepEqual(punchCorrectionTimes({ workDate: '2026-09-15', checkIn: '22:00', checkOut: '06:00', checkOutNextDay: true, endpointEvidence }),
    { checkIn: evidence.attendance.check_in, checkOut: evidence.attendance.check_out });
  assert.equal(punchCorrectionTimes({ workDate: '2026-09-15', checkIn: '', checkOut: '06:00', checkOutNextDay: false, endpointEvidence }).checkOut,
    '2026-09-15T00:30:00.000Z');
});

test('nearby and same-minute raw punches need a corroborated first/last endpoint for the selected day', () => {
  const evidence = context('2026-09-02', '2026-09-02T09:22:09+05:30', '2026-09-02T19:49:02+05:30');
  evidence.raw_punches.unshift({ punch_time: '2026-09-01T09:22:50+05:30' });
  evidence.raw_punches.push({ punch_time: '2026-09-02T09:22:49+05:30' }, { punch_time: '2026-09-03T09:22:37+05:30' });
  assert.equal(punchCorrectionEndpointEvidence(evidence).checkIn, '2026-09-02T09:22:09+05:30');
  evidence.attendance.punches = [];
  evidence.attendance.first_punch_at = null;
  assert.equal(punchCorrectionEndpointEvidence(evidence).checkIn, null, 'do not pick an arbitrary same-minute raw record');
  evidence.attendance.first_punch_at = evidence.attendance.check_in;
  evidence.attendance.work_date = '2026-09-01';
  assert.deepEqual(punchCorrectionEndpointEvidence(evidence), { checkIn: null, checkOut: null });
});

test('schedule-derived and interior punch times are not retained as verified endpoints', () => {
  const evidence = context('2026-09-02', '2026-09-02T09:22:09+05:30', '2026-09-02T19:49:02+05:30');
  evidence.raw_punches.push({ punch_time: '2026-09-02T12:30:43+05:30' });
  const endpointEvidence = punchCorrectionEndpointEvidence(evidence);
  assert.equal(punchCorrectionTimes({ workDate: '2026-09-02', checkIn: '12:30', checkOut: '', endpointEvidence }).checkIn,
    '2026-09-02T07:00:00.000Z');
  evidence.attendance.check_in = '2026-09-02T09:00:17+05:30';
  assert.equal(punchCorrectionEndpointEvidence(evidence).checkIn, null);
  evidence.attendance.check_in = evidence.attendance.first_punch_at;
  evidence.raw_punches = [];
  assert.equal(punchCorrectionEndpointEvidence(evidence).checkIn, null, 'stale derived evidence alone cannot verify a device endpoint');
});
