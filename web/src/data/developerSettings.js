import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { usePermissions } from '../auth/usePermissions';
import { supabase } from '../lib/supabaseClient';
import { developerSettingsKey, developerKeysKey, fetchDeveloperSettings, fetchDeveloperKeys } from '../lib/developerSettings';

export function useDeveloperSettings() {
  const { user } = useAuth();
  const { isSuperAdmin } = usePermissions();
  return useQuery({
    queryKey: developerSettingsKey(user?.id),
    enabled: Boolean(user?.id && isSuperAdmin),
    queryFn: ({ signal }) => fetchDeveloperSettings(supabase, signal),
    meta: { persist: false },
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

export function useDeveloperKeys() {
  const { user } = useAuth();
  const { isSuperAdmin } = usePermissions();
  return useQuery({
    queryKey: developerKeysKey(user?.id),
    enabled: Boolean(user?.id && isSuperAdmin),
    queryFn: ({ signal }) => fetchDeveloperKeys(supabase, signal),
    meta: { persist: false },
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}
