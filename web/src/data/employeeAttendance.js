// One person's attendance over a date range, plus the numbers derived from it.
//
// Kept apart from the day-wide hooks in attendance.js: those answer "who is in today" across the
// whole company, this answers "what does this person's month look like". Different question,
// different shape, different cost — this one is bounded by the range, not the headcount.
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { supabase } from '../lib/supabaseClient';
import { summarise } from '../lib/attendanceSummary';

// Re-exported so the screen keeps importing its data and its arithmetic from one place.
// clockLabel is gone: lib/clock.js formats a time of day in whichever shape the reader chose.
export { summarise } from '../lib/attendanceSummary';

const SELECT = `
  id, work_date, status, day_type, check_in, check_out, hours,
  worked_minutes, late_minutes, early_exit_minutes, ot_minutes,
  is_late, is_early_exit, is_missing_punch, is_lop, day_fraction,
  leave_type, remarks, punch_count, scheduled_in, scheduled_out, source,
  punches, break_minutes, breaks_incomplete,
  shift:shifts(id, code, name, start_time, end_time, is_flexible, full_day_minutes)
`;

export function useEmployeeAttendance(employeeId, from, to) {
  return useQuery({
    // enabled below, but the key still carries the id so switching person refetches cleanly
    queryKey: ['attendance', 'employee', employeeId, from, to],
    enabled: Boolean(employeeId && from && to),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('attendance')
        .select(SELECT)
        .eq('employee_id', employeeId)
        .gte('work_date', from)
        .lte('work_date', to)
        .order('work_date', { ascending: false })
        // A year of one person is ~365 rows; the ceiling is here so it can never silently truncate.
        .limit(1000);
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useEmployeeAttendanceSummary(employeeId, from, to) {
  const q = useEmployeeAttendance(employeeId, from, to);
  const summary = useMemo(() => summarise(q.data ?? []), [q.data]);
  return { ...q, summary };
}
