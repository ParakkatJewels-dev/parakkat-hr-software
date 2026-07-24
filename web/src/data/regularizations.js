// Attendance regularization: missed-punch corrections and their approval flow.
//
// Approving one does not write to public.attendance directly. The trigger in 0014 queues the
// affected date, and the engine re-derives it — so a correction goes through exactly the same
// rules as a device punch, rather than a second code path that can disagree with the first.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';

const SELECT = `
  id, work_date, check_in, check_out, reason, status, decision_note, decided_at, created_at,
  employee:employees!attendance_regularizations_employee_id_fkey(
    id, full_name, employee_code, branch:branches(id, name)
  ),
  approver:employees!attendance_regularizations_approver_id_fkey(id, full_name)
`;

export function useRegularizations(status) {
  return useQuery({
    queryKey: ['regularizations', status ?? 'all'],
    queryFn: async () => {
      let query = supabase
        .from('attendance_regularizations')
        .select(SELECT)
        .order('created_at', { ascending: false })
        .limit(500);

      if (status) query = query.eq('status', status);

      const { data, error } = await query;
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useMyRegularizations(employeeId) {
  return useQuery({
    enabled: Boolean(employeeId),
    queryKey: ['regularizations', 'mine', employeeId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('attendance_regularizations')
        .select(SELECT)
        .eq('employee_id', employeeId)
        .order('work_date', { ascending: false })
        .limit(100);
      if (error) throw error;
      return data ?? [];
    },
  });
}

/**
 * Raise a correction. Times arrive as 'HH:mm' wall-clock and are combined with the work date in
 * IST — building them with `new Date(...)` in the browser's timezone would file a correction at
 * the wrong instant for anyone whose laptop is not on IST.
 */
export function useCreateRegularization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ employeeId, workDate, checkIn, checkOut, reason }) => {
      const atIst = (clock) => (clock ? new Date(`${workDate}T${clock}:00+05:30`).toISOString() : null);

      const { error } = await supabase.from('attendance_regularizations').insert({
        employee_id: employeeId,
        work_date: workDate,
        check_in: atIst(checkIn),
        check_out: atIst(checkOut),
        reason,
        status: 'Pending',
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['regularizations'] }),
  });
}

export function useDecideRegularization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, decision, note }) => {
      const { error } = await supabase
        .from('attendance_regularizations')
        .update({
          status: decision,
          decision_note: note ?? null,
          decided_at: new Date().toISOString(),
        })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['regularizations'] });
      // The recompute trigger has queued the date; attendance updates once the queue drains.
      qc.invalidateQueries({ queryKey: ['attendance'] });
    },
  });
}
