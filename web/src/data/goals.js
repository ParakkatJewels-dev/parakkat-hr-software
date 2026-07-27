// Goal / KRA tracking. RLS scopes it: an employee sees and progresses their own goals, a manager
// with performance.manage sets and manages goals for their team.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';

export function useGoals() {
  return useQuery({
    queryKey: ['goals'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('goals')
        .select(
          `id, employee_id, title, description, target_date, weight, progress, status, created_at,
           employee:employees!goals_employee_id_fkey(id, full_name, employee_code, department:departments(name))`
        )
        .order('status')
        .order('target_date', { ascending: true, nullsFirst: false })
        .limit(1000);
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useSaveGoal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...row }) => {
      const q = id
        ? supabase.from('goals').update(row).eq('id', id)
        : supabase.from('goals').insert(row);
      const { error } = await q;
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['goals'] }),
  });
}

export function useDeleteGoal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      const { error } = await supabase.from('goals').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['goals'] }),
  });
}
