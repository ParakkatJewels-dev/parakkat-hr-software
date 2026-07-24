// Data hooks for Attendance. Employees punch their own (attendance.punch @ self);
// managers/HR view and regularize within scope (attendance.read / attendance.manage).
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';

export function useAttendance() {
  return useQuery({
    queryKey: ['attendance'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('attendance')
        .select(
          `id, work_date, check_in, check_out, hours, status,
           employee:employees(full_name, employee_code, branch:branches(code))`
        )
        .order('work_date', { ascending: false })
        .limit(200);
      if (error) throw error;
      return data ?? [];
    },
  });
}

// Upsert today's row (check-in creates it, check-out updates it). Conflict key: (employee_id, work_date).
export function usePunch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (row) => {
      const { error } = await supabase
        .from('attendance')
        .upsert(row, { onConflict: 'employee_id,work_date' });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['attendance'] }),
  });
}
