// Sync status for the admin monitoring screen.
//
// Reads sync_state / sync_runs straight from Supabase (RLS gates them behind device.manage) and
// gets the live BioTime reachability check from the service, which is the only thing that can
// actually talk to BioTime.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { apiGet, apiPost, apiHealth } from '../lib/attendanceApi';

/** Live view from the service. Fails soft — the service may simply not be running. */
export function useServiceStatus() {
  return useQuery({
    queryKey: ['service-status'],
    queryFn: () => apiGet('/api/status'),
    refetchInterval: 30_000,
    retry: false,
  });
}

export function useServiceHealth() {
  return useQuery({
    queryKey: ['service-health'],
    queryFn: apiHealth,
    refetchInterval: 30_000,
    retry: false,
  });
}

/** Database-only fallback, so the screen still shows history when the service is down. */
export function useSyncState() {
  return useQuery({
    queryKey: ['sync-state'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sync_state')
        .select('key, last_transaction_id, last_punch_time, last_success_at, last_error, consecutive_failures, updated_at');
      if (error) throw error;
      return data ?? [];
    },
    refetchInterval: 60_000,
  });
}

export function useSyncRuns(limit = 25) {
  return useQuery({
    queryKey: ['sync-runs', limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sync_runs')
        .select(
          `id, kind, status, started_at, finished_at, duration_ms, pages_fetched,
           records_fetched, records_inserted, records_skipped, unmatched_codes, error_message`
        )
        .order('started_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data ?? [];
    },
    refetchInterval: 60_000,
  });
}

export function useTriggerSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (kind) => apiPost(`/api/sync/${kind}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sync-runs'] });
      qc.invalidateQueries({ queryKey: ['sync-state'] });
      qc.invalidateQueries({ queryKey: ['service-status'] });
      qc.invalidateQueries({ queryKey: ['attendance'] });
    },
  });
}

export function useTriggerBackfill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ from, to, recompute }) => apiPost('/api/backfill', { from, to, recompute }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sync-runs'] }),
  });
}

export const RUN_STATUS_STYLES = {
  success: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300',
  partial: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300',
};

export function relativeTime(iso) {
  if (!iso) return 'never';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
