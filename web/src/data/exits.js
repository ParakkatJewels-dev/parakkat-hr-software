// Exit / separation records. HR manages within scope; employees can file & see their own.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';

export function useExits() {
  return useQuery({
    queryKey: ['exits'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('exits')
        .select('id, last_day, reason, status, approvals, created_at, employee:employees(full_name, employee_code, department:departments(name))')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
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
