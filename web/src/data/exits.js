// Exit / separation records. HR manages within scope; employees can file & see their own.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { fetchCollection } from '../lib/fetchCollection';

export function useExits({ enabled = true } = {}) {
  return useQuery({
    enabled,
    queryKey: ['exits'],
    queryFn: () => fetchCollection(() => supabase
        .from('exits')
        .select('id, employee_id, entity_id, zone_id, branch_id, department_id, created_by, last_day, reason, status, approvals, created_at, employee:employees(id, full_name, employee_code, entity_id, zone_id, branch_id, department_id, branch:branches(code), department:departments(name))')
        .order('created_at', { ascending: false })
        .order('id')),
  });
}

export function useDecideExitClearance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, department, decision }) => {
      const { data, error } = await supabase.rpc('decide_exit_clearance', {
        p_exit_id: id, p_department: department, p_decision: decision,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['exits'] }),
  });
}

export function useCompleteExit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      const { data, error } = await supabase.rpc('complete_exit', { p_exit_id: id });
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['exits'] }),
  });
}

export function useAddExit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload) => {
      const { error } = await supabase.from('exits').insert(payload);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['exits'] }),
  });
}
