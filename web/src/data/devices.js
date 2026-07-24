// Biometric terminals, and the device-code -> employee mapping queue.
//
// The mapping queue is the screen that makes the whole pipeline usable: BioTime emp_codes are
// device enrolment numbers and do not match the HR employee_code, so someone has to say who is
// who. The sync worker ranks candidates by name similarity; this is where a human confirms.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { apiPost } from '../lib/attendanceApi';

export function useDevices() {
  return useQuery({
    queryKey: ['devices'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('devices')
        .select(
          `id, serial_number, alias, ip_address, area_name, entity_id, branch_id,
           last_punch_at, last_seen_at, is_active,
           branch:branches(id, name, code), entity:entities(id, code, name)`
        )
        .order('last_punch_at', { ascending: false, nullsFirst: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useSaveDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, branch_id, entity_id, alias, is_active }) => {
      const { error } = await supabase
        .from('devices')
        .update({
          branch_id: branch_id || null,
          entity_id: entity_id || null,
          ...(alias !== undefined ? { alias } : {}),
          ...(is_active !== undefined ? { is_active } : {}),
        })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['devices'] }),
  });
}

/** The mapping queue. `status` filters to unmatched / ambiguous / auto / manual / ignored. */
export function useDeviceMappings(status) {
  return useQuery({
    queryKey: ['device-mappings', status ?? 'all'],
    queryFn: async () => {
      let query = supabase
        .from('biotime_employees')
        .select(
          `id, emp_code, full_name, first_name, last_name, department_name, area_name,
           position_name, is_active, employee_id, link_status, match_suggestions, last_synced_at,
           employee:employees(id, full_name, employee_code, branch:branches(id, name))`
        )
        .order('link_status')
        .order('emp_code')
        .limit(1000);

      if (status) query = query.eq('link_status', status);

      const { data, error } = await query;
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** Counts per link_status, for the queue's filter chips. */
export function useMappingCounts() {
  return useQuery({
    queryKey: ['device-mappings', 'counts'],
    queryFn: async () => {
      const { data, error } = await supabase.from('biotime_employees').select('link_status').limit(5000);
      if (error) throw error;

      const counts = { unmatched: 0, ambiguous: 0, auto: 0, manual: 0, ignored: 0, total: 0 };
      for (const row of data ?? []) {
        counts.total += 1;
        if (row.link_status in counts) counts[row.link_status] += 1;
      }
      return counts;
    },
  });
}

/**
 * Confirm a mapping.
 *
 * Routed through the service API rather than a direct table update, because linking a code is not
 * just one column: the service also adopts the punches already stored under that code and queues
 * the affected dates for recompute. Doing it client-side would leave months of punches orphaned.
 */
export function useLinkDeviceCode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ empCode, employeeId, ignore = false }) =>
      apiPost('/api/mapping/link', { empCode, employeeId, ignore }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['device-mappings'] });
      qc.invalidateQueries({ queryKey: ['attendance'] });
    },
  });
}

export function useRefreshSuggestions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost('/api/mapping/suggest'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['device-mappings'] }),
  });
}

/** Employee search for the manual-pick path when no suggestion is right. */
export function useEmployeeSearch(term) {
  return useQuery({
    enabled: (term ?? '').trim().length >= 2,
    queryKey: ['employee-search', term],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('employees')
        .select('id, full_name, employee_code, branch:branches(id, name)')
        .ilike('full_name', `%${term.trim()}%`)
        .eq('status', 'Active')
        .order('full_name')
        .limit(25);
      if (error) throw error;
      return data ?? [];
    },
  });
}

export const LINK_STATUS_LABELS = {
  unmatched: 'Needs mapping',
  ambiguous: 'Ambiguous',
  auto: 'Auto-linked',
  manual: 'Confirmed',
  ignored: 'Ignored',
};

export const LINK_STATUS_STYLES = {
  unmatched: 'bg-orange-100 text-orange-800 dark:bg-orange-950/40 dark:text-orange-300',
  ambiguous: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
  auto: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
  manual: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
  ignored: 'bg-neutral-150 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400',
};
