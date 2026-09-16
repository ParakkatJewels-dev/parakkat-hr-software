import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { fetchCollection } from '../lib/fetchCollection';
import { isMissingSchema } from '../lib/pendingMigration';

export function useTicketAccess({ enabled = true } = {}) {
  return useQuery({
    enabled,
    queryKey: ['ticket-access'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_ticket_access');
      if (error) throw error;
      return data;
    },
  });
}

export function useTicketCategories({ enabled = true } = {}) {
  return useQuery({
    enabled,
    queryKey: ['ticket-categories'],
    queryFn: async () => {
      try {
        return await fetchCollection(() => supabase.rpc('list_ticket_categories').order('name').order('id'));
      } catch (error) {
        if (isMissingSchema(error)) throw new Error('Ticket categories are not available yet. Contact your administrator.');
        throw error;
      }
    },
  });
}

export function useSaveTicketCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id = null, name, departmentId, isActive = true, isHrQueue = false }) => {
      const { data, error } = await supabase.rpc('save_ticket_category', {
        _id: id, _name: name.trim(), _department_id: departmentId, _is_active: isActive, _is_hr_queue: isHrQueue,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: ['ticket-categories'] }),
      qc.invalidateQueries({ queryKey: ['ticket-access'] }),
      qc.invalidateQueries({ queryKey: ['tickets'] }),
      qc.invalidateQueries({ queryKey: ['section-counts'] }),
    ]),
  });
}
