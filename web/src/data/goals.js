// Goal / KRA tracking. RLS scopes it: an employee sees and progresses their own goals, a manager
// with performance.manage sets and manages goals for their team.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { fetchCollection } from '../lib/fetchCollection';

export function useGoals() {
  return useQuery({
    queryKey: ['goals'],
    queryFn: () => fetchCollection(() => supabase
        .from('goals')
        .select(
          `id, employee_id, entity_id, zone_id, branch_id, department_id, title, description, target_date, weight, progress, status, created_at,
           employee:employees!goals_employee_id_fkey(id, full_name, employee_code, department:departments(name))`
        )
        .order('status')
        .order('target_date', { ascending: true, nullsFirst: false }).order('id')),
  });
}

export function useSaveGoal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...row }) => {
      const q = id
        ? supabase.from('goals').update(row).eq('id', id)
        : supabase.from('goals').insert(row);
      const { data, error } = await q.select('id').single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['goals'] }),
  });
}

export function useDeleteGoal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      const { data, error } = await supabase.from('goals').delete().eq('id', id).select('id').single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['goals'] }),
  });
}
