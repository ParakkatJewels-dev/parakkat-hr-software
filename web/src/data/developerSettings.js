import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { usePermissions } from '../auth/usePermissions';
import { supabase } from '../lib/supabaseClient';
import {
  developerSettingsKey, developerKeysKey, fetchDeveloperSettings, fetchDeveloperKeys,
  myAgentAccessKey, myAgentKeysKey, fetchMyAgentAccess, fetchMyAgentKeys,
} from '../lib/developerSettings';

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

/** Whether this person may connect an AI assistant, and whether the administrator has turned it on. */
export function useMyAgentAccess() {
  const { user } = useAuth();
  const { canAny } = usePermissions();
  return useQuery({
    queryKey: myAgentAccessKey(user?.id),
    enabled: Boolean(user?.id && canAny('api.connect')),
    queryFn: ({ signal }) => fetchMyAgentAccess(supabase, signal),
    meta: { persist: false },
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

export function useMyAgentKeys(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: myAgentKeysKey(user?.id),
    enabled: Boolean(user?.id && enabled),
    queryFn: ({ signal }) => fetchMyAgentKeys(supabase, signal),
    meta: { persist: false },
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}
