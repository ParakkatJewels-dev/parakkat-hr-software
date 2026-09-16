// QA only: reproduces attendance output defects without a database or remote calls.
// Run from the repository root:
// services/attendance/node_modules/.bin/tsx --experimental-test-module-mocks docs/qa/2026-09-16/attendance-edge-repro.cjs
const assert = require('node:assert/strict');
const { mock } = require('node:test');

mock.module(require.resolve('../../../services/attendance/src/config/env.ts'), {
  namedExports: { env: { APP_TIMEZONE: 'Asia/Kolkata', BIOTIME_TIMEZONE: 'Asia/Kolkata', PUNCH_DEDUPE_SECONDS: 60 } },
});
const { processDay } = require('../../../services/attendance/src/engine/processDay.ts');
const shift = {
  id: 'qa-shift', code: 'QA', name: 'QA flexible',
  startTime: '09:00:00', endTime: '17:30:00', crossesMidnight: false,
  graceInMinutes: 15, graceOutMinutes: 15, breakMinutes: 40, breakPolicy: 'excess',
  weeklyOffs: [0], fullDayMinutes: 510, halfDayMinutes: 255,
  otAfterMinutes: 30, minOtMinutes: 30, otBasis: 'worked',
  missedPunchPolicy: 'exception', lateAbsentMinutes: 540, earlyAbsentMinutes: 540,
  shortDayToleranceMinutes: 30, isFlexible: true,
};
const stamp = (time, date = '2026-07-15') => new Date(`${date}T${time}:00+05:30`);
let id = 0;
const punch = (time, date) => ({ id: BigInt(++id), punchTime: stamp(time, date), punchState: null, terminalSn: 'QA', terminalAlias: 'QA' });
const day = (overrides) => ({ employeeId: 'qa-employee', workDate: '2026-07-15', shift,
  dayType: 'working', holidayName: null, punches: [], leave: null, regularization: null, ...overrides });
const actual = (result) => ({ status: result.status, checkIn: result.checkIn?.toISOString() ?? null,
  checkOut: result.checkOut?.toISOString() ?? null, workedMinutes: result.workedMinutes,
  dayFraction: result.dayFraction, breakMinutes: result.breakMinutes, breaksIncomplete: result.breaksIncomplete,
  isMissingPunch: result.isMissingPunch });
const results = [];
function check(name, input, expected) {
  const output = actual(processDay(day(input)));
  try {
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(output[key], value);
    results.push({ name, pass: true, expected, actual: output });
  } catch {
    results.push({ name, pass: false, expected, actual: output });
  }
}

check('CONTROL: two real punches form a full day', {
  punches: [punch('09:00'), punch('17:30')],
}, { workedMinutes: 510, dayFraction: 1, isMissingPunch: false });

check('ATT-01: approved missing check-in preserves the one real departure', {
  punches: [punch('16:30')],
  regularization: { id: 'qa-reg-in', checkIn: stamp('09:00'), checkOut: null },
}, { checkIn: stamp('09:00').toISOString(), checkOut: stamp('16:30').toISOString(), workedMinutes: 450, isMissingPunch: false });

check('ATT-02: approved missing check-out repairs the break timeline', {
  punches: [punch('09:00'), punch('12:00'), punch('13:30')],
  regularization: { id: 'qa-reg-break', checkIn: null, checkOut: stamp('17:30') },
}, { workedMinutes: 460, breakMinutes: 90, breaksIncomplete: false, isMissingPunch: false });

check('ATT-03: a corrected weekly-off punch is no longer missing', {
  workDate: '2026-07-19', punches: [punch('09:00', '2026-07-19')],
  regularization: { id: 'qa-reg-off', checkIn: null, checkOut: stamp('11:00', '2026-07-19') },
}, { workedMinutes: 120, isMissingPunch: false });

check('ATT-04: paid half-day leave and missing-punch half credit combine', {
  punches: [punch('09:00')],
  leave: { id: 'qa-leave', type: 'CL', dayFraction: 0.5, isLop: false, isPaid: true },
}, { dayFraction: 1, status: 'On Leave', isMissingPunch: true });

console.log(JSON.stringify({ checks: results.length, pass: results.filter(r => r.pass).length,
  fail: results.filter(r => !r.pass).length, results }, null, 2));
process.exitCode = results.some(r => !r.pass) ? 1 : 0;
