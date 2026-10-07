import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attendanceIssueReasons, attendanceReviewRows } from './attendanceIssues.js';

const day = { id: 'day', employee_id: 'worker', work_date: '2026-07-15', day_type: 'working', day_fraction: 1, status: 'Present' };
test('payroll issue dates include missing punches, shifts, breaks and invalid credits, without flagging ordinary time results', () => {
  for (const patch of [{ is_late: true }, { ot_minutes: 90 }, { status: 'Absent', day_fraction: 0 },
    { status: 'Half Day', day_fraction: 0.5 }, { is_early_exit: true }, { is_long_break: true },
    { status: 'Weekly Off', day_type: 'weekly_off', day_fraction: 0 }]) {
    assert.deepEqual(attendanceIssueReasons({ ...day, ...patch }), []);
  }
  assert.deepEqual(attendanceIssueReasons({ ...day, is_missing_punch: true, breaks_incomplete: true }), ['Missing punch', 'Incomplete break punches']);
  assert.deepEqual(attendanceIssueReasons({ ...day, status: 'No Shift' }), ['No shift assigned']);
  assert.deepEqual(attendanceIssueReasons({ ...day, status: 'Missing Punch', status_override: 'Present' }), []);
  for (const patch of [{ day_fraction: null }, { day_fraction: -0.5 }, { day_fraction: 2 }, { day_type: 'invalid' }]) {
    assert.deepEqual(attendanceIssueReasons({ ...day, ...patch }), ['Invalid attendance credit']);
  }
});

test('unprocessed dates use the payroll employment window, stop at today and remain separate from real attendance', () => {
  const rows = [day];
  const options = { employeeId: 'worker', from: '2026-07-01', to: '2026-07-31', today: '2026-07-17',
    payrollAttendance: { employee_id: 'worker', in_payroll_month: true, employment_from: '2026-07-14', employment_to: '2026-07-16' } };
  const result = attendanceReviewRows(rows, options);
  assert.deepEqual(result.map(row => row.work_date), ['2026-07-16', '2026-07-15', '2026-07-14']);
  assert.equal(result[1], day);
  assert.deepEqual(attendanceIssueReasons(result[0]), ['Attendance not processed']);
  assert.equal(rows.length, 1);
  assert.equal(attendanceReviewRows(rows, { ...options, payrollAttendance: undefined }), rows);
  assert.equal(attendanceReviewRows(rows, { ...options, payrollAttendance: { ...options.payrollAttendance, employee_id: 'other' } }), rows);
  assert.equal(attendanceReviewRows(rows, { ...options, payrollAttendance: { ...options.payrollAttendance, in_payroll_month: false } }), rows);
  assert.deepEqual(attendanceReviewRows([], { ...options, payrollAttendance: { ...options.payrollAttendance, employment_to: '2026-07-31' } }).map(row => row.work_date),
    ['2026-07-17', '2026-07-16', '2026-07-15', '2026-07-14']);
});
