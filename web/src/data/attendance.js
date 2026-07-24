// Data hooks for attendance.
//
// Attendance is now DERIVED from BioTime punches by the engine in services/attendance — it is not
// something the app writes. So these hooks are read-only over public.attendance, plus the handful
// of actions (recompute, exports) that go through the service API.
//
// RLS decides which rows come back: a branch manager sees their branch, an employee sees only
// their own. The client never filters for security, only for presentation.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { apiPost, apiDownload } from '../lib/attendanceApi';

const SELECT = `
  id, work_date, status, day_type, check_in, check_out, hours,
  worked_minutes, late_minutes, early_exit_minutes, ot_minutes,
  is_late, is_early_exit, is_missing_punch, is_lop, day_fraction,
  leave_type, remarks, punch_count, scheduled_in, scheduled_out, computed_at,
  employee:employees!attendance_employee_id_fkey(
    id, full_name, employee_code,
    branch:branches(id, name, code),
    department:departments(id, name)
  ),
  shift:shifts(id, code, name, start_time, end_time)
`;

/** IST calendar date — never derive this from toISOString(), which is UTC. */
export function todayIso() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function monthRange(year, month) {
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from, to: `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}` };
}

/** Everyone's status for a single day — powers the "who's in today" board. */
export function useDayAttendance(workDate) {
  const date = workDate || todayIso();
  return useQuery({
    queryKey: ['attendance', 'day', date],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('attendance')
        .select(SELECT)
        .eq('work_date', date)
        .order('check_in', { ascending: true, nullsFirst: false })
        .limit(2000);
      if (error) throw error;
      return data ?? [];
    },
    // The engine refreshes today's rows every 15 minutes; polling more often than that just
    // re-fetches identical data.
    refetchInterval: 120_000,
  });
}

/** One employee's month, for the calendar view. */
export function useMonthlyAttendance(employeeId, year, month) {
  const { from, to } = monthRange(year, month);
  return useQuery({
    enabled: Boolean(employeeId),
    queryKey: ['attendance', 'month', employeeId, from],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('attendance')
        .select(SELECT)
        .eq('employee_id', employeeId)
        .gte('work_date', from)
        .lte('work_date', to)
        .order('work_date');
      if (error) throw error;
      return data ?? [];
    },
  });
}

/**
 * Everything HR needs to act on in a date range: lateness, absence, missing punches, unassigned
 * shifts. Deliberately one query — an exceptions screen that fires four is four times as slow and
 * shows them arriving at different moments.
 */
export function useAttendanceExceptions(from, to) {
  return useQuery({
    queryKey: ['attendance', 'exceptions', from, to],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('attendance')
        .select(SELECT)
        .gte('work_date', from)
        .lte('work_date', to)
        .or('is_late.eq.true,is_missing_punch.eq.true,is_early_exit.eq.true,status.eq.Absent,status.eq.No Shift')
        .order('work_date', { ascending: false })
        .limit(1000);
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** Aggregate counters for the dashboard tiles. */
export function useAttendanceSummary(workDate) {
  const { data = [], ...rest } = useDayAttendance(workDate);

  const summary = data.reduce(
    (acc, row) => {
      acc.total += 1;
      if (row.check_in) acc.checkedIn += 1;
      if (row.check_in && !row.check_out) acc.stillIn += 1;
      if (row.status === 'Absent') acc.absent += 1;
      if (row.status === 'On Leave') acc.onLeave += 1;
      if (row.is_late) acc.late += 1;
      if (row.is_missing_punch) acc.missingPunch += 1;
      if (row.status === 'Weekly Off' || row.status === 'Holiday') acc.off += 1;
      return acc;
    },
    { total: 0, checkedIn: 0, stillIn: 0, absent: 0, onLeave: 0, late: 0, missingPunch: 0, off: 0 }
  );

  return { ...rest, data, summary };
}

/** Raw punches behind one employee-date — shown when HR opens a day to investigate it. */
export function useRawPunches(employeeId, workDate) {
  return useQuery({
    enabled: Boolean(employeeId && workDate),
    queryKey: ['punches', employeeId, workDate],
    queryFn: async () => {
      // Widened by a day either side so a night shift's punches are included.
      const start = new Date(`${workDate}T00:00:00+05:30`);
      const from = new Date(start.getTime() - 12 * 3600_000).toISOString();
      const to = new Date(start.getTime() + 36 * 3600_000).toISOString();

      const { data, error } = await supabase
        .from('raw_punches')
        .select('id, punch_time, punch_state, punch_state_label, terminal_sn, terminal_alias, source')
        .eq('employee_id', employeeId)
        .gte('punch_time', from)
        .lte('punch_time', to)
        .order('punch_time');
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useRecompute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ from, to, employeeIds }) => apiPost('/api/recompute', { from, to, employeeIds }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['attendance'] }),
  });
}

export function useExportRegister() {
  return useMutation({
    mutationFn: ({ year, month, branchIds }) =>
      apiDownload(
        '/api/exports/register',
        { year, month, branchIds },
        `attendance-register-${year}-${String(month).padStart(2, '0')}.xlsx`
      ),
  });
}

export function useExportPayroll() {
  return useMutation({
    mutationFn: ({ year, month, branchIds, columns }) =>
      apiDownload(
        '/api/exports/payroll',
        { year, month, branchIds, columns },
        `payroll-attendance-${year}-${String(month).padStart(2, '0')}.xlsx`
      ),
  });
}

export const STATUS_STYLES = {
  Present: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
  'Half Day': 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
  Absent: 'bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300',
  'On Leave': 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-300',
  Holiday: 'bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300',
  'Weekly Off': 'bg-neutral-150 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400',
  'Missing Punch': 'bg-orange-100 text-orange-800 dark:bg-orange-950/40 dark:text-orange-300',
  'No Shift': 'bg-violet-100 text-violet-800 dark:bg-violet-950/40 dark:text-violet-300',
};

export const STATUS_CODES = {
  Present: 'P',
  'Half Day': 'H',
  Absent: 'A',
  'On Leave': 'L',
  Holiday: 'F',
  'Weekly Off': 'W',
  'Missing Punch': 'M',
  'No Shift': '?',
};

export const fmtTime = (iso) =>
  iso
    ? new Date(iso).toLocaleTimeString('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : '—';

export const fmtMinutes = (m) => {
  if (!m || m <= 0) return '—';
  const h = Math.floor(m / 60);
  const mins = Math.round(m % 60);
  return h ? `${h}h ${mins}m` : `${mins}m`;
};
