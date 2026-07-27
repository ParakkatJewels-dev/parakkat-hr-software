// Workspace settings (org_settings table) + self-service profile updates.
// Reading is open to any signed-in user; writing the workspace row is super-admin only (RLS).
// Profile edits go through the update_my_profile RPC, which whitelists the columns an employee
// may change on their own record.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';

export function useWorkspaceSettings() {
  return useQuery({
    queryKey: ['org-settings', 'workspace'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('org_settings')
        .select('key, value, updated_at')
        .eq('key', 'workspace')
        .maybeSingle();
      if (error) throw error;
      return data?.value ?? {};
    },
  });
}

export function useSaveWorkspaceSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (value) => {
      const { error } = await supabase
        .from('org_settings')
        .upsert({ key: 'workspace', value }, { onConflict: 'key' });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org-settings'] }),
  });
}

export function useUpdateMyProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ phone }) => {
      const { error } = await supabase.rpc('update_my_profile', { _phone: phone ?? '' });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['employees'] }),
  });
}
