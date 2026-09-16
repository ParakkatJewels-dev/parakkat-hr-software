import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { supabase } from '../lib/supabaseClient';

const SCREENS = ['tasks', 'leave', 'expense', 'attendance', 'helpdesk'];

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
    // Never carry an oversight count into the personal view, or across signed-in users.
    queryKey: ['section-counts', user?.id ?? null, Boolean(selfOnly)],
    staleTime: 60_000,
    // Realtime normally refreshes these; this bounded, visible-only fallback also catches
    // changes no longer visible through RLS (for example, a removed secondary assignee).
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal } = {}) => {
      let request = supabase.rpc('get_section_counts', { _self_only: Boolean(selfOnly) });
      if (signal) request = request.abortSignal(signal);
      const { data, error } = await request;
      if (error) throw error;
      return validateSectionCounts(data);
    },
  });
}
