// Match the blockers used by payroll_attendance_metrics. A late arrival, overtime or a
// recorded absence is not by itself a missing/invalid attendance record.
export function attendanceIssueReasons(row) {
  if (row.attendance_not_processed) return ['Attendance not processed'];
  const reasons = [];
  if (row.status_override == null) {
    if (row.is_missing_punch || row.status === 'Missing Punch') reasons.push('Missing punch');
    if (row.status === 'No Shift') reasons.push('No shift assigned');
    if (row.breaks_incomplete) reasons.push('Incomplete break punches');
  }
  const fraction = Number(row.day_fraction);
  if (row.day_fraction == null || !Number.isFinite(fraction) || fraction < 0 || fraction > 1
    || (row.day_type != null && !['working', 'weekly_off', 'holiday'].includes(row.day_type))) {
    reasons.push('Invalid attendance credit');
  }
  return reasons;
}

const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '')
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

// Only the server's payroll employment window establishes which unprocessed days are
// expected. Do not invent absences, include future days, or alter the attendance summary.
export function attendanceReviewRows(rows, { employeeId, from, to, today, payrollAttendance } = {}) {
  if (!payrollAttendance || payrollAttendance.employee_id !== employeeId || payrollAttendance.in_payroll_month === false
    || ![from, to, today, payrollAttendance.employment_from, payrollAttendance.employment_to].every(validDate)) return rows;
  const start = [from, payrollAttendance.employment_from].sort().at(-1);
  const end = [to, payrollAttendance.employment_to, today].sort()[0];
  if (start > end) return rows;
  const present = new Set(rows.map(row => row.work_date));
  const missing = [];
  for (let day = start; day <= end;) {
    if (!present.has(day)) missing.push({ id: `unprocessed:${employeeId}:${day}`, employee_id: employeeId,
      work_date: day, status: 'Not processed', attendance_not_processed: true });
    const next = new Date(`${day}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    day = next.toISOString().slice(0, 10);
  }
  return [...rows, ...missing].sort((a, b) => b.work_date.localeCompare(a.work_date));
}
