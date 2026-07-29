// Sync status for the admin monitoring screen.
//
// Reads sync_state / sync_runs straight from Supabase (RLS gates them behind device.manage) and
// gets the live BioTime reachability check from the service, which is the only thing that can
// actually talk to BioTime.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { apiGet, apiHealth } from '../lib/attendanceApi';

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

/**
 * Ask the service to do something, without needing to reach it.
 *
 * The row goes into Supabase and the service picks it up within about twenty seconds. That is a
 * little slower than calling the service directly, and it is the only thing that works from
 * outside the office — the service sits on a LAN behind a firewall, and a browser will not let an
 * HTTPS page call http://192.168.1.45:8091 under any circumstances. Correct everywhere beats
 * instant on one network.
 */
async function queueCommand(kind, params = {}) {
  const { data, error } = await supabase.rpc('request_service_command', {
    _kind: kind,
    _params: params,
  });
  if (error) throw new Error(error.message);
  return data; // the command id
}

const REFRESH_AFTER_COMMAND = ['sync-runs', 'sync-state', 'sync-health', 'service-commands', 'attendance'];

export function useTriggerSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (kind) =>
      queueCommand(kind === 'employees' ? 'sync_employees' : 'sync_transactions'),
    onSuccess: () => REFRESH_AFTER_COMMAND.forEach((k) => qc.invalidateQueries({ queryKey: [k] })),
  });
}

/** Recent requests and how they went — so a queued command is visible, not a silent wait. */
export function useServiceCommands(limit = 8) {
  return useQuery({
    queryKey: ['service-commands', limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('service_commands')
        .select('id, kind, params, status, requested_at, finished_at, result, error_message')
        .order('requested_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data ?? [];
    },
    // Realtime pushes changes to this table, so this interval is only a safety net for a browser
    // whose websocket could not connect — realtime.js logs and falls back to polling in that case.
    // Still a little quicker while something is in flight, in case that is the situation.
    refetchInterval: (q) =>
      (q.state.data ?? []).some((c) => c.status === 'pending' || c.status === 'running') ? 15_000 : 120_000,
  });
}

export function useTriggerBackfill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ from, to, recompute }) => queueCommand('backfill', { from, to, recompute }),
    onSuccess: () => REFRESH_AFTER_COMMAND.forEach((k) => qc.invalidateQueries({ queryKey: [k] })),
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

/**
 * Is the sync actually working? Answered from Supabase alone.
 *
 * The card on this screen used to answer it by calling the service's own /api/status over HTTP.
 * That only ever worked from a browser sitting on the same LAN as the HR laptop — anywhere else it
 * failed and the screen read "Service offline" while punches were arriving normally every two
 * minutes. Worse, an HTTPS-hosted app cannot call a plain-HTTP LAN address at all, so on a real
 * deployment that check could never succeed.
 *
 * A successful `transactions` run is better evidence anyway: it can only happen if the service is
 * alive AND it authenticated against Easy Time Pro AND the database accepted the write. That
 * evidence lands in Supabase, which every browser can read from anywhere.
 */
export function useSyncHealth() {
  return useQuery({
    queryKey: ['sync-health'],
    refetchInterval: 60_000,
    queryFn: async () => {
      // Midnight IST as an instant, so "today" means the working day, not the UTC day.
      const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000);
      const istMidnight = new Date(
        Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate()) - 5.5 * 3600 * 1000
      ).toISOString();

      const [state, lastRun, today, unmapped] = await Promise.all([
        supabase
          .from('sync_state')
          .select('key, last_punch_time, last_success_at, last_error, consecutive_failures')
          .eq('key', 'transactions')
          .maybeSingle(),
        supabase
          .from('sync_runs')
          .select('id, kind, status, started_at, finished_at, error_message')
          .eq('kind', 'transactions')
          .order('started_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from('raw_punches')
          .select('id', { count: 'exact', head: true })
          .gte('punch_time', istMidnight),
        supabase
          .from('raw_punches')
          .select('id', { count: 'exact', head: true })
          .is('employee_id', null),
      ]);

      if (state.error) throw state.error;

      const lastSuccess = state.data?.last_success_at ?? null;
      const ageMin = lastSuccess ? (Date.now() - new Date(lastSuccess).getTime()) / 60_000 : Infinity;
      const failures = state.data?.consecutive_failures ?? 0;

      // The punch poll runs every two minutes. Ten allows for a slow run plus a skipped tick
      // without crying wolf; an hour means somebody needs to look at the laptop.
      const level =
        failures > 0 && ageMin > 10 ? 'failing'
        : ageMin <= 10 ? 'ok'
        : ageMin <= 60 ? 'stale'
        : 'down';

      // --- and, separately, is the TERMINAL still handing over punches? -----------------------
      //
      // These are two different questions and answering only the first is how a whole afternoon
      // went missing. On 29 July the terminal stopped uploading at 13:07. Our service carried on
      // polling every two minutes and every poll succeeded — there was simply nothing new to
      // fetch — so this card read "Connected" for five hours while no punch reached the system.
      // Nobody had any reason to look.
      //
      // "Connected" on the terminal is no better a signal: it reflects a heartbeat, and a ZKTeco
      // device will hold that up quite happily while its upload queue is jammed.
      //
      // The only trustworthy evidence is arrival. The threshold is measured, not guessed: over
      // thirty days of working hours the median gap between punches is 0 minutes, the 99th
      // percentile is 30, and the longest legitimate silence ever recorded is 74. Ninety minutes
      // therefore sits clear of anything normal, and would have raised this at 14:37.
      const lastPunchTime = state.data?.last_punch_time ?? null;
      const punchAgeMin = lastPunchTime
        ? (Date.now() - new Date(lastPunchTime).getTime()) / 60_000
        : Infinity;

      // Silence outside working hours means everyone went home, so no alarm then — an alert that
      // fires every single night is one nobody reads by the end of the week.
      const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
      const istHour = istNow.getUTCHours();
      const istDow = istNow.getUTCDay();
      const withinWorkingHours = istDow !== 0 && istHour >= 8 && istHour < 20;

      const terminalLevel =
        !withinWorkingHours ? 'off-hours'
        : punchAgeMin <= 45 ? 'ok'
        : punchAgeMin <= 90 ? 'quiet'
        : 'stalled';

      return {
        level,
        lastSuccess,
        lastPunchTime,
        lastError: state.data?.last_error ?? null,
        consecutiveFailures: failures,
        lastRun: lastRun.data ?? null,
        punchesToday: today.count ?? null,
        punchesUnmapped: unmapped.count ?? null,
        minutesSinceSuccess: Number.isFinite(ageMin) ? Math.round(ageMin) : null,
        terminalLevel,
        minutesSincePunch: Number.isFinite(punchAgeMin) ? Math.round(punchAgeMin) : null,
        withinWorkingHours,
      };
    },
  });
}

export const SYNC_LEVEL = {
  ok: {
    label: 'Connected',
    tone: 'text-emerald-600 dark:text-emerald-400',
    hint: 'Punches are arriving from Easy Time Pro.',
  },
  stale: {
    label: 'Falling behind',
    tone: 'text-amber-600 dark:text-amber-400',
    hint: 'The last successful pull is over 10 minutes old. Usually recovers by itself.',
  },
  failing: {
    label: 'Failing',
    tone: 'text-red-600 dark:text-red-400',
    hint: 'Runs are erroring. See the last error below.',
  },
  down: {
    label: 'Not syncing',
    tone: 'text-red-600 dark:text-red-400',
    hint: 'Nothing has synced for over an hour — check the HR laptop is on and on the office network.',
  },
};

/**
 * The other half of the answer: is the punching machine still handing punches over?
 *
 * Kept apart from SYNC_LEVEL on purpose. "Our service is running" and "the terminal is delivering"
 * are separate facts, and reading only the first is how five hours of punches went missing without
 * anything on screen looking wrong.
 */
export const TERMINAL_LEVEL = {
  ok: {
    label: 'Delivering',
    tone: 'text-emerald-600 dark:text-emerald-400',
    hint: 'The punching machine is handing punches over normally.',
  },
  quiet: {
    label: 'Quiet',
    tone: 'text-neutral-500 dark:text-neutral-400',
    hint: 'No punch for a while. Normal in a lull — the longest ordinary gap here is about an hour.',
  },
  stalled: {
    label: 'Not delivering',
    tone: 'text-red-600 dark:text-red-400',
    hint: 'Longer than any normal gap. The machine may show "connected" and still be stuck: that light is a heartbeat, not an upload. Try Get Transactions in Easy Time Pro, then reboot the terminal.',
  },
  'off-hours': {
    label: 'Outside working hours',
    tone: 'text-neutral-450',
    hint: 'Nobody is expected to be punching, so silence here means nothing.',
  },
};
