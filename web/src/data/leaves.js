// Data hooks for the Leave module. RLS scopes what each user sees:
// an employee sees their own; a branch manager/HR sees their branch's; a zonal manager, their zone.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { windowStartIso } from '../lib/dates';

export function useLeaves({ enabled = true } = {}) {
  return useQuery({
    enabled,
    queryKey: ['leaves'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('leaves')
        .select(
          // disambiguate: leaves has two FKs to employees (employee_id + approver_id)
          `id, type, start_date, end_date, days, reason, status, created_at,
           employee:employees!leaves_employee_id_fkey(id, full_name, employee_code, branch_id, branch:branches(code))`
        )
        // Bounded: the whole table was fetched on every dashboard. Screens show recent activity;
        // historical analysis goes through the Reports RPCs.
        .gte('start_date', windowStartIso(180))
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useApplyLeave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload) => {
      // ancestry (entity/branch/…) is stamped automatically by the DB trigger from employee_id
      const { error } = await supabase.from('leaves').insert({ ...payload, status: 'Pending' });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['leaves'] }),
  });
}

export function useSetLeaveStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status }) => {
      const { error } = await supabase.from('leaves').update({ status }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['leaves'] }),
  });
}
