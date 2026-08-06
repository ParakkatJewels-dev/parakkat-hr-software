// Sync status for the admin monitoring screen.
//
// Reads sync_state / sync_runs straight from Supabase (RLS gates them behind device.manage) and
// gets the live BioTime reachability check from the service, which is the only thing that can
// actually talk to BioTime.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { apiGet, apiHealth } from '../lib/attendanceApi';
import { diagnose } from '../lib/syncDiagnosis';

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

/**
 * Wait for a queued command to finish, and hand back the row.
 *
 * Polls rather than subscribing: realtime is already wired for this table, but a download is a
 * foreground action a person is watching, and it must not hang forever if the websocket never
 * connected. The database settles anything uncollected after five minutes with a message saying so,
 * which is where the timeout below comes from — giving up earlier would report a failure the
 * service is about to contradict.
 */
async function awaitCommand(id, { timeoutMs = 6 * 60_000, everyMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const { data, error } = await supabase
      .from('service_commands')
      .select('status, error_message, result, result_file, result_filename')
      .eq('id', id)
      .single();
    if (error) throw new Error(error.message);

    if (data.status === 'done') return data;
    if (data.status === 'failed' || data.status === 'cancelled') {
      throw new Error(data.error_message || 'The service could not complete that request.');
    }
    if (Date.now() > deadline) {
      throw new Error('That is taking longer than expected. Check Shifts & Devices for the outcome.');
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** base64 -> Blob, without inflating the whole file into a JS string array. */
function base64ToBlob(base64, mime) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke on the next tick — Safari cancels the download if the URL dies too early.
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

/**
 * Generate an Excel export and download it, without needing to reach the HR laptop.
 *
 * The old version called the service's HTTP API directly, which cannot work from the deployed site:
 * the page is HTTPS and the service answers on a plain-HTTP LAN address, so the browser kills the
 * request before it is sent. Both buttons were dead everywhere except inside the office over http.
 *
 * The file is built where the generator already lives — it colours cells by attendance status using
 * a library the frontend does not carry — and travels back as base64 on the command row. Slower
 * than a direct download by the length of one poll; the alternative was not working at all.
 */
export function useQueuedExport(kind) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ year, month, branchIds, columns }) => {
      const id = await queueCommand(kind === 'register' ? 'export_register' : 'export_payroll', {
        year, month, branchIds, columns,
      });
      const row = await awaitCommand(id);
      if (!row.result_file) {
        throw new Error('The export finished but the file was not attached. Try again.');
      }
      saveBlob(base64ToBlob(row.result_file, XLSX_MIME), row.result_filename || 'export.xlsx');
      return { filename: row.result_filename };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['service-commands'] }),
  });
}

/**
 * Rebuild attendance for a date range.
 *
 * Queued for the same reason the exports are: the direct route is unreachable from an HTTPS page.
 * request_service_command still requires attendance.manage organisation-wide for an unscoped
 * recompute (0071), so this is not a way around that check — it is the same check, reached from
 * somewhere the button actually works.
 */
export function useQueuedRecompute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ from, to, employeeIds }) => {
      const id = await queueCommand('recompute', { from, to, employeeIds });
      // The engine's summary — rowsWritten, employees — is what the screen reports back, so hand
      // back `result` rather than the envelope it travelled in.
      const { result } = await awaitCommand(id);
      return result ?? {};
    },
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

      const [state, lastRun, newestRun, today, unmapped] = await Promise.all([
        supabase
          .from('sync_state')
          .select('key, last_punch_time, last_success_at, last_poll_at, last_error, consecutive_failures')
          .eq('key', 'transactions')
          .maybeSingle(),
        supabase
          .from('sync_runs')
          .select('id, kind, status, started_at, finished_at, error_message')
          .eq('kind', 'transactions')
          .order('started_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        // ANY kind, not just transactions. This is the heartbeat that separates "the service is
        // dead" from "the service is fine and there is nothing to fetch" — the two looked
        // identical before, and the second is what happened on 29 July.
        supabase
          .from('sync_runs')
          .select('started_at')
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
      const lastPunchTime = state.data?.last_punch_time ?? null;
      const failures = state.data?.consecutive_failures ?? 0;

      // Which of the three links is broken, if any. The rules and the reasoning live in
      // lib/syncDiagnosis.js, away from React so they can be tested.
      // The liveness signal, taken as the later of two things on purpose.
      //
      // last_poll_at beats on every attempt and is the right answer — but only a service running
      // the build that sets it will have one, and the HR laptop is not always on the newest build.
      // Falling back to the newest sync_run keeps the status honest during that gap, and once the
      // laptop is updated the column takes over on its own. Taking the LATER of the two means
      // neither can drag the reading backwards.
      const heartbeat = [state.data?.last_poll_at ?? null, newestRun.data?.started_at ?? null]
        .filter(Boolean)
        .sort()
        .pop() ?? null;

      const dx = diagnose({
        nowMs: Date.now(),
        newestRunAt: heartbeat,
        lastSuccessAt: lastSuccess,
        lastPunchAt: lastPunchTime,
      });

      return {
        level: dx.level,
        brokenHop: dx.brokenHop,
        minutes: dx.minutes,
        lastSuccess,
        lastPunchTime,
        newestRunAt: heartbeat,
        lastError: state.data?.last_error ?? null,
        consecutiveFailures: failures,
        lastRun: lastRun.data ?? null,
        punchesToday: today.count ?? null,
        punchesUnmapped: unmapped.count ?? null,
        minutesSinceSuccess: Number.isFinite(
          lastSuccess ? (Date.now() - new Date(lastSuccess).getTime()) / 60_000 : Infinity
        ) ? Math.round((Date.now() - new Date(lastSuccess).getTime()) / 60_000) : null,
        minutesSincePunch: Number.isFinite(dx.minutes) ? Math.round(dx.minutes) : null,
      };
    },
  });
}

// The status table now lives with the rules that choose it, so a level can never exist without a
// message or vice versa. Re-exported here because every screen already imports from this module.
export { DIAGNOSIS, forHumans } from '../lib/syncDiagnosis';
