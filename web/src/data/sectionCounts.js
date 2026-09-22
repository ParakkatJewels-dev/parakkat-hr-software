import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { NAVIGATION_COUNT_KEYS } from '../lib/navigationCounts.js';

const SCREENS = NAVIGATION_COUNT_KEYS;

// A malformed or not-yet-deployed response is unavailable, never an empty queue.
export function validateSectionCounts(data) {
  if (!data || SCREENS.some(key => !Number.isSafeInteger(data[key]) || data[key] < 0)) {
    throw new Error('Section counts could not be loaded. Try again.');
  }
  return Object.fromEntries(SCREENS.map(key => [key, data[key]]));
}

export function useSectionCounts({ enabled = true, selfOnly = false } = {}) {
  const { user } = useAuth();
  return useQuery({
    enabled: enabled && Boolean(user?.id),
    // Isolate the complete navigation contract from persisted five-queue summaries, as well as
    // from another user or the oversight/personal lens. Prefix invalidation still refreshes all.
    queryKey: ['section-counts', user?.id ?? null, Boolean(selfOnly), 'navigation-v2'],
    staleTime: 60_000,
    // Realtime normally refreshes these; this bounded, visible-only fallback also catches
    // changes no longer visible through RLS (for example, a removed secondary assignee).
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal } = {}) => {
      let request = supabase.rpc('get_navigation_counts', { _self_only: Boolean(selfOnly) });
      if (signal) request = request.abortSignal(signal);
      const { data, error } = await request;
      if (error) throw error;
      return validateSectionCounts(data);
    },
  });
}
