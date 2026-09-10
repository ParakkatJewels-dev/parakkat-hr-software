// Data hooks for Helpdesk tickets. Employees raise their own (ticket.create @ self);
// support/HR handle within scope (ticket.manage). tickets has two FKs to employees -> disambiguate.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { windowStartIso } from '../lib/dates';
import { fetchCollection } from '../lib/fetchCollection';

export function useTickets() {
  return useQuery({
    queryKey: ['tickets'],
    queryFn: () => fetchCollection(() => supabase
        .from('tickets')
        .select(
          // The ancestry columns are selected so the status control can be gated per row, the way
          // tickets_update checks it. They are part of the column list, so no comments inside it.
          `id, category, subject, description, priority, status, created_at,
           entity_id, zone_id, branch_id, department_id, employee_id,
           employee:employees!tickets_employee_id_fkey(full_name, employee_code, branch:branches(code))`
        )
        .gte('created_at', windowStartIso(180))
        .order('created_at', { ascending: false }).order('id')),
  });
}

export function useAddTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload) => {
      const { error } = await supabase.from('tickets').insert({ ...payload, status: 'Open' });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tickets'] });
      qc.invalidateQueries({ queryKey: ['notification-ref-statuses'] });
    },
  });
}

/**
 * Move a ticket along.
 *
 * The `.select()` is load-bearing, exactly as in expenses: PostgREST answers an UPDATE that RLS
 * filtered to zero rows with a plain success, so changing the status of a ticket outside your scope
 * did nothing, said nothing, and refetched the unchanged row. It reads as "the status is not
 * updating" rather than as "you are not allowed to do that".
 */
export function useSetTicketStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status }) => {
      const { data, error } = await supabase
        .from('tickets')
        .update({ status })
        .eq('id', id)
        .select('id');
      if (error) throw error;
      if (!data?.length) {
        throw new Error('That ticket is outside the area you handle, so nothing was changed.');
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tickets'] });
      qc.invalidateQueries({ queryKey: ['notification-ref-statuses'] });
    },
  });
}
