// Isolated visual QA only. Writes remain in memory; this adapter deliberately leaves
// recomputation pending rather than implementing a second attendance calculation engine.
import { fixture, tables, today } from './fixtures.js';
import { addDays } from '../src/lib/dateRange.js';

export const punchCorrectionFixtures = typeof window !== 'undefined'
  && new URL(window.location.href).searchParams.has('qa-punch-corrections');
export const correctionDay = addDays(today, -1);
const history = [], receipts = new Map();
if (punchCorrectionFixtures) {
  // Use the production enum so ordinary days stay out of the issue-only review.
  tables.attendance.forEach(row => { if (row.day_type === 'Working') row.day_type = 'working'; });
  const person = fixture.employees[3];
  const start = `${correctionDay}T09:00:00+05:30`;
  tables.payslips = tables.payslips.filter(row => ![person.id, fixture.employees[6].id].includes(row.employee_id));
  tables.attendance.push({ id: 'qa-missing-checkout', employee_id: person.id, employee: person,
    entity_id: person.entity_id, zone_id: person.zone_id, branch_id: person.branch_id, department_id: person.department_id,
    work_date: correctionDay, status: 'Half Day', day_type: 'working', check_in: start, check_out: null,
    first_punch_at: start, last_punch_at: start, punches: [start], punch_count: 1,
    hours: 0, worked_minutes: 0, is_missing_punch: true, day_fraction: 0.5, is_lop: true,
    late_minutes: 0, early_exit_minutes: 0, ot_minutes: 0, break_minutes: 0, computed_at: start, is_locked: false,
  });
  tables.raw_punches.push({ id: 'qa-original-punch', employee_id: person.id, punch_time: start, source: 'biotime' });
}

export function punchCorrectionRpc(name, args, access) {
  if (!punchCorrectionFixtures || !['get_attendance_punch_correction_context', 'save_attendance_punch_correction'].includes(name)) return null;
  const fail = (message, code = '42501') => ({ error: { message, code } });
  const person = fixture.employees.find(row => row.id === args._employee_id);
  if (!person || !access.allows('attendance.read', person)) return fail('Outside your attendance scope.');
  const day = args._work_date;
  const attendance = tables.attendance.find(row => row.employee_id === person.id && row.work_date === day) ?? null;
  const records = tables.attendance_regularizations.filter(row => row.employee_id === person.id && row.work_date === day);
  const active = records.find(row => ['Pending', 'Approved'].includes(row.status)) ?? null;
  const raw = tables.raw_punches.filter(row => row.employee_id === person.id && row.punch_time.slice(0, 10) === day);
  const locked = Boolean(attendance?.is_locked || tables.payslips.some(row => row.employee_id === person.id && row.period === day.slice(0, 7) && row.status === 'Published'));
  const blocked = !access.allows('attendance.manage', person) ? 'You do not have permission to correct these punches.'
    : person.id === access.employee.id ? 'Another HR manager must correct your own attendance.'
      : locked ? 'This attendance day is locked by finalized payroll.'
        : active?.status === 'Pending' ? 'Review the pending correction request before editing this day.' : null;
  const revision = JSON.stringify({ attendance, active, raw });
  const context = { employee_id: person.id, work_date: day, source_revision: revision, attendance,
    active_correction: active, raw_punches: raw, check_in: active?.check_in ?? attendance?.check_in ?? null,
    check_out: active?.check_out ?? attendance?.check_out ?? null, is_locked: locked, can_correct: !blocked,
    blocked_reason: blocked, pending_recompute: history.some(row => row.employee_id === person.id && row.work_date === day),
    history: records, correction_history: history.filter(row => row.employee_id === person.id && row.work_date === day) };
  if (name === 'get_attendance_punch_correction_context') return { rows: [context], one: true };
  if (!access.canWrite) return fail('Synthetic writes are disabled.');
  const previous = receipts.get(args._request_id);
  if (previous) return previous.payload === JSON.stringify(args)
    ? { rows: [{ ...previous.result, already_saved: true }], one: true } : fail('Request ID already used.', '40001');
  if (blocked) return fail(blocked);
  if (revision !== args._source_revision) return fail('This attendance day changed. Reload the latest punches before saving.', '40001');
  if (!args._request_id || !args._reason?.trim() || (!args._check_in && !args._check_out)) return fail('Enter corrected times and a reason.', '22023');
  if (active) active.status = 'Cancelled';
  const corrected = { id: args._request_id, employee_id: person.id, employee: person, work_date: day,
    check_in: args._check_in, check_out: args._check_out, reason: args._reason,
    status: 'Approved', requested_by: access.userId, decided_by: access.userId,
    entity_id: person.entity_id, branch_id: person.branch_id, department_id: person.department_id,
    created_at: new Date().toISOString(), decided_at: new Date().toISOString() };
  tables.attendance_regularizations.push(corrected);
  history.unshift({ request_id: args._request_id, correction_id: corrected.id, employee_id: person.id,
    work_date: day, reason: args._reason, changed_by: access.userId, changed_at: corrected.created_at,
    before_state: { attendance }, after_state: corrected, previous_correction_id: active?.id ?? null });
  const result = { correction_id: corrected.id, employee_id: person.id, work_date: day, recompute_pending: true, already_saved: false };
  receipts.set(args._request_id, { payload: JSON.stringify(args), result });
  access.event?.('attendance_regularizations', 'INSERT', corrected);
  return { rows: [result], one: true, mutated: true };
}
