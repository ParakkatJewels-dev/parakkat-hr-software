// Data-access hooks for the org hierarchy (entities -> zones -> branches -> departments -> designations).
// The hierarchy is small, so we load all five tables in one query and shape the tree client-side.
// RLS enforces who can read/write; these hooks just talk to Supabase.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';

const ORG_TABLES = ['entities', 'zones', 'branches', 'departments', 'designations'];

export function useOrg() {
  return useQuery({
    queryKey: ['org'],
    queryFn: async () => {
      const results = await Promise.all(ORG_TABLES.map((t) => supabase.from(t).select('*')));
      const out = {};
      results.forEach((res, i) => {
        if (res.error) throw res.error;
        out[ORG_TABLES[i]] = res.data ?? [];
      });
      return out; // { entities, zones, branches, departments, designations }
    },
  });
}

// Single mutation covering insert / update / toggle-active for any org table.
// Usage: mutate({ table: 'branches', op: 'update', row: { id, zone_id } })
export function useOrgMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ table, op, row }) => {
      let query;
      if (op === 'insert') {
        query = supabase.from(table).insert(row).select().single();
      } else if (op === 'update') {
        const { id, ...rest } = row;
        query = supabase.from(table).update(rest).eq('id', id).select().single();
      } else {
        throw new Error(`Unknown org op: ${op}`);
      }
      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org'] }),
  });
}
