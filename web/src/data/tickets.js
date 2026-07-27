// Data hooks for Helpdesk tickets. Employees raise their own (ticket.create @ self);
// support/HR handle within scope (ticket.manage). tickets has two FKs to employees -> disambiguate.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { windowStartIso } from '../lib/dates';

export function useTickets() {
  return useQuery({
    queryKey: ['tickets'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('tickets')
        .select(
          `id, category, subject, description, priority, status, created_at,
           employee:employees!tickets_employee_id_fkey(full_name, employee_code, branch:branches(code))`
        )
        .gte('created_at', windowStartIso(180))
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useAddTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload) => {
      const { error } = await supabase.from('tickets').insert({ ...payload, status: 'Open' });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tickets'] }),
  });
}

export function useSetTicketStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status }) => {
      const { error } = await supabase.from('tickets').update({ status }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tickets'] }),
  });
}
