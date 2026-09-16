// Data hooks for Helpdesk tickets. Employees raise their own (ticket.create @ self);
// support/HR handle within scope (ticket.manage). tickets has two FKs to employees -> disambiguate.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { windowStartIso } from '../lib/dates';
import { fetchCollection } from '../lib/fetchCollection';

export function useTickets({ enabled = true } = {}) {
  return useQuery({
    enabled,
    queryKey: ['tickets'],
    // The server includes old unresolved tickets and computes management access against the
    // receiving department. Requester ancestry cannot answer who handles a routed ticket.
    queryFn: () => fetchCollection(() => supabase
        .rpc('list_tickets', { _since: windowStartIso(180) })
        .order('created_at', { ascending: false }).order('id')),
  });
}

export function useAddTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ categoryId, subject, description, priority }) => {
      const { data, error } = await supabase.rpc('create_ticket', { _category_id: categoryId,
        _subject: subject.trim(), _description: description?.trim() || null, _priority: priority || 'Medium' });
      if (error) throw error;
      return data;
    },
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: ['tickets'] }),
      qc.invalidateQueries({ queryKey: ['section-counts'] }),
      qc.invalidateQueries({ queryKey: ['notification-ref-statuses'] }),
    ]),
  });
}

/** The RPC validates destination access and reports a refusal instead of a zero-row success. */
export function useSetTicketStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status }) => {
      const { error } = await supabase.rpc('set_ticket_status', { _id: id, _status: status });
      if (error) throw error;
    },
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: ['tickets'] }),
      qc.invalidateQueries({ queryKey: ['section-counts'] }),
      qc.invalidateQueries({ queryKey: ['notification-ref-statuses'] }),
    ]),
  });
}
