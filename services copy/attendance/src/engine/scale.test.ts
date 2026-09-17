import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processDay } from './processDay';
import type { DayInput, ShiftDefinition } from './types';

const shift: ShiftDefinition = {
  id: 'fixture-flexible', code: 'FLEX', name: 'Fixture flexible shift', startTime: '09:00', endTime: '17:30',
  crossesMidnight: false, graceInMinutes: 0, graceOutMinutes: 0, breakMinutes: 40, breakPolicy: 'excess',
  weeklyOffs: [0], fullDayMinutes: 510, halfDayMinutes: 255, otAfterMinutes: 0, minOtMinutes: 1,
  otBasis: 'worked', missedPunchPolicy: 'present', lateAbsentMinutes: 510, earlyAbsentMinutes: 510,
  shortDayToleranceMinutes: 30, isFlexible: true,
};

test('explicit half-day LOP remains unpaid when flexible attendance otherwise credits a full day', () => {
  const input: DayInput = {
    employeeId: 'fixture', workDate: '2026-07-15', shift, dayType: 'working', holidayName: null,
    leave: { id: 'half-lop', type: 'LOP', isLop: true, isPaid: false, dayFraction: 0.5 },
    regularization: null,
    punches: [
      { id: 1n, punchTime: new Date('2026-07-15T03:30:00Z'), punchState: null, terminalSn: null, terminalAlias: null },
      { id: 2n, punchTime: new Date('2026-07-15T07:45:00Z'), punchState: null, terminalSn: null, terminalAlias: null },
    ],
  };
  assert.equal(processDay(input).dayFraction, 0.5);
  assert.equal(processDay(input).isLop, true);
  assert.equal(processDay({ ...input, punches: input.punches.slice(0, 1) }).dayFraction, 0.5, 'a reconstructed missing punch cannot repay LOP');
  assert.equal(processDay({ ...input, leave: { ...input.leave!, isLop: false, isPaid: true, type: 'CL' } }).dayFraction, 1, 'paid half-day leave still combines with work');
});

test('503 employees across a complete month produce exact credits, work and overtime totals', (context) => {
  const startedAt = performance.now();
  const dates: DayInput[] = Array.from({ length: 31 }, (_, index) => {
    const day = index + 1;
    return {
      employeeId: '', workDate: `2026-07-${String(day).padStart(2, '0')}`, shift,
      dayType: day === 15 ? 'holiday' : 'working', holidayName: day === 15 ? 'Fixture holiday' : null,
      leave: null, regularization: null,
      // Fixed independent UTC instants represent 09:00 and 17:31 IST: 511 measured minutes.
      punches: [
        { id: 1n, punchTime: new Date(Date.UTC(2026, 6, day, 3, 30)), punchState: null, terminalSn: null, terminalAlias: null },
        { id: 2n, punchTime: new Date(Date.UTC(2026, 6, day, 12, 1)), punchState: null, terminalSn: null, terminalAlias: null },
      ],
    };
  });
  let payable = 0;
  let worked = 0;
  let overtime = 0;
  let restDaysWorked = 0;
  for (let employee = 1; employee <= 503; employee++) {
    for (const fixture of dates) {
      const result = processDay({ ...fixture, employeeId: `employee-${employee}` });
      assert.equal(result.status, 'Present');
      assert.equal(result.punchCount, 2);
      assert.equal(result.dayFraction, 1);
      assert.equal(result.workedMinutes, 511);
      assert.equal(result.isMissingPunch, false);
      assert.equal(result.isLate, false);
      payable += result.dayFraction;
      worked += result.workedMinutes;
      overtime += result.otMinutes;
      if (result.dayType !== 'working') restDaysWorked++;
    }
  }
  // July 2026 has four Sundays plus our July 15 holiday: 5 rest days and 26 workdays.
  assert.equal(payable, 503 * 31);
  assert.equal(worked, 503 * 31 * 511);
  assert.equal(restDaysWorked, 503 * 5);
  assert.equal(overtime, 503 * (5 * 511 + 26));
  context.diagnostic(`15,593 employee-days verified in ${Math.round(performance.now() - startedAt)} ms`);
});
