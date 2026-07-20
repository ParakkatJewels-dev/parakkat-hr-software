// Data hooks for Asset Management. Read within scope (asset.read); allocate/manage (asset.manage).
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';

export function useAssets() {
  return useQuery({
    queryKey: ['assets'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('assets')
        .select(
          `id, asset_type, name, serial, status, created_at,
           employee:employees(full_name, employee_code, branch:branches(code))`
        )
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useUpsertAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...rest }) => {
      const q = id
        ? supabase.from('assets').update(rest).eq('id', id)
        : supabase.from('assets').insert(rest);
      const { error } = await q;
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assets'] }),
  });
}
