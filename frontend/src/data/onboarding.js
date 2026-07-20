// Onboarding boards scoped by onboarding.manage.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';

export function useOnboarding() {
  return useQuery({
    queryKey: ['onboarding'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('onboarding')
        .select('id, name, job_title, join_date, progress, tasks, entity:entities(code), branch:branches(code)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useUpdateOnboarding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, progress, tasks }) => {
      const { error } = await supabase.from('onboarding').update({ progress, tasks }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['onboarding'] }),
  });
}
