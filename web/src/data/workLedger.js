// Work Ledger data. Query keys start with 'work-ledger' ("ledger" already names the payroll
// advance ledger). Reads go through ledger_* RPCs that check who may see the ledger; writes are
// owner-only on the server, so nothing here can write someone else's ledger.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { importBatches, IMPORT_ORDER } from '../lib/ledger/importWorkbook.js';

export const ledgerKeys = {
  root: ['work-ledger'],
  bootstrap: (owner) => ['work-ledger', 'bootstrap', owner ?? 'me'],
  home: (owner) => ['work-ledger', 'home', owner ?? 'me'],
  task: (owner, id) => ['work-ledger', 'task', owner ?? 'me', id],
  report: (owner, period, date) => ['work-ledger', 'report', owner ?? 'me', period, date ?? null],
  campaigns: (owner) => ['work-ledger', 'campaigns', owner ?? 'me'],
  campaign: (owner, id) => ['work-ledger', 'campaign', owner ?? 'me', id],
  ideas: (owner, status) => ['work-ledger', 'ideas', owner ?? 'me', status ?? 'all'],
  library: (owner) => ['work-ledger', 'library', owner ?? 'me'],
  insights: (owner) => ['work-ledger', 'insights', owner ?? 'me'],
  events: () => ['work-ledger', 'google-events'],
  google: () => ['work-ledger', 'google-status'],
  team: () => ['work-ledger', 'team'],
};

export const newId = () => globalThis.crypto.randomUUID();

export async function ledgerRpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data;
}
const rpc = ledgerRpc;

function useLedgerQuery(key, name, args, { enabled = true, persist = true, staleTime } = {}) {
  const { user } = useAuth();
  return useQuery({
    queryKey: key,
    enabled: Boolean(user?.id && enabled),
    ...(persist ? {} : { meta: { persist: false } }),
    ...(staleTime !== undefined ? { staleTime } : {}),
    queryFn: () => rpc(name, args),
  });
}

/** Opens (and on first use seeds) the signed-in person's ledger, or reads a team member's. */
export function useLedgerBootstrap(owner = null) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ledgerKeys.bootstrap(owner),
    enabled: Boolean(user?.id),
    queryFn: () => (owner ? rpc('ledger_bootstrap', { _owner: owner }) : rpc('ledger_open')),
  });
}
// Home stays in the browser's cache so the last board can be read offline.
export const useLedgerHome = (owner = null) => useLedgerQuery(ledgerKeys.home(owner), 'ledger_home', { _owner: owner });
export const useLedgerTask = (id, owner = null) => useLedgerQuery(ledgerKeys.task(owner, id), 'ledger_task', { _id: id, _owner: owner }, { enabled: Boolean(id), persist: false });
export const useLedgerCampaigns = (owner = null) => useLedgerQuery(ledgerKeys.campaigns(owner), 'ledger_campaigns', { _owner: owner });
export const useLedgerCampaign = (id, owner = null) => useLedgerQuery(ledgerKeys.campaign(owner, id), 'ledger_campaign', { _id: id, _owner: owner }, { enabled: Boolean(id), persist: false });
export const useLedgerIdeas = (status = null, owner = null) => useLedgerQuery(ledgerKeys.ideas(owner, status), 'ledger_ideas', { _status: status, _owner: owner });
export const useLedgerLibrary = (owner = null) => useLedgerQuery(ledgerKeys.library(owner), 'ledger_library', { _owner: owner });
export const useLedgerInsights = (owner = null) => useLedgerQuery(ledgerKeys.insights(owner), 'ledger_insights', { _owner: owner }, { persist: false });
export const useLedgerTeam = () => useQuery({ queryKey: ledgerKeys.team(), queryFn: () => rpc('ledger_team_members'), meta: { persist: false } });

export function useLedgerReport({ owner = null, period, date }) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ledgerKeys.report(owner, period, date),
    enabled: Boolean(user?.id && period),
    // Reports can be long; they are cheap to fetch again and are not kept in browser storage.
    meta: { persist: false },
    queryFn: () => fetchLedgerReport({ owner, period, date }),
  });
}

export async function fetchLedgerReport({ owner = null, period, date }) {
  return rpc('ledger_report', { _period: period, _date: date ?? null, _owner: owner });
}
export const fetchCampaignDetails = (owner = null) => rpc('ledger_campaign_details', { _owner: owner });
export const searchLedger = (query, owner = null) => rpc('ledger_search', { _query: query, _owner: owner });

export async function fetchLedgerExport() {
  const rows = await rpc('ledger_export_tasks');
  return Array.isArray(rows) ? rows : [];
}

/**
 * One mutation for every ledger write: run the RPC, then refresh what it may have changed. A board
 * status move updates the card at once and the server confirms in the background.
 */
export function useLedgerAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ name, args }) => rpc(name, args),
    onMutate: async ({ optimistic }) => {
      if (!optimistic) return undefined;
      await client.cancelQueries({ queryKey: ledgerKeys.home(null) });
      const previous = client.getQueryData(ledgerKeys.home(null));
      if (previous) {
        client.setQueryData(ledgerKeys.home(null), {
          ...previous, pending: previous.pending.map((task) => (task.id === optimistic.id ? { ...task, ...optimistic.patch } : task)),
        });
      }
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) client.setQueryData(ledgerKeys.home(null), context.previous);
    },
    onSettled: () => client.invalidateQueries({ queryKey: ledgerKeys.root }),
  });
}

/** Upload a file into the owner's task folder, then record it; a failed record removes the upload. */
export async function uploadLedgerFile({ owner, taskId, file }) {
  if (file.size > 52428800) throw new Error('Files can be at most 50 MB.');
  const id = newId();
  const safe = file.name.normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').slice(-120) || 'file';
  const path = `${owner}/${taskId}/${id}-${safe}`;
  const bucket = supabase.storage.from('ledger-files');
  const { error } = await bucket.upload(path, file, { upsert: false, contentType: file.type || 'application/octet-stream' });
  if (error) throw error;
  try {
    return await rpc('ledger_add_file', { _id: id, _task: taskId, _name: file.name, _path: path, _size: file.size, _type: file.type || null });
  } catch (failure) {
    await bucket.remove([path]).catch(() => {});
    throw failure;
  }
}

export async function signedFileUrl(path) {
  const { data, error } = await supabase.storage.from('ledger-files').createSignedUrl(path, 3600);
  if (error) throw error;
  return data.signedUrl;
}

// Google Calendar goes through the server (/api/google/*), carrying the user's own session token.
async function googleCall(action) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Sign in again to use Google Calendar.');
  const response = await fetch(`/api/google/${action}`, { method: 'POST', headers: { Authorization: `Bearer ${session.access_token}` }, credentials: 'same-origin' });
  let body = null;
  try { body = await response.json(); } catch { /* empty */ }
  if (response.status === 409) return { reconnect: true };
  if (!response.ok) throw new Error(body?.error?.message ?? 'Google Calendar did not answer. Try again in a moment.');
  return body;
}
export async function connectGoogleCalendar() {
  const { url } = await googleCall('start');
  window.location.assign(url);
}
export const syncGoogleCalendar = () => googleCall('sync');
export const useGoogleStatus = () => useLedgerQuery(ledgerKeys.google(), 'ledger_google_status', {}, { persist: false });
export const disconnectGoogleCalendar = () => googleCall('disconnect');
export function useGoogleEvents(enabled) {
  return useQuery({ queryKey: ledgerKeys.events(), enabled: Boolean(enabled), meta: { persist: false }, staleTime: 5 * 60_000, retry: false,
    queryFn: () => googleCall('events') });
}

export async function previewLedgerImport(kind, legacyRows) {
  return rpc('ledger_import_preview', { _kind: kind, _legacy_rows: legacyRows });
}

/**
 * Sends parsed workbook rows in dependency order and small batches. Calls onProgress after each
 * batch. Returns per-kind totals. Stops on the first server error; a re-run continues safely
 * because rows are matched on their original sheet row.
 */
export async function runLedgerImport(kinds, { onProgress } = {}) {
  const plan = IMPORT_ORDER.flatMap((kind) => importBatches(kinds[kind] ?? []).map((rows) => ({ kind, rows })));
  const totals = {};
  let sent = 0;
  const total = plan.reduce((sum, step) => sum + step.rows.length, 0);
  for (const step of plan) {
    const result = await rpc('ledger_import_batch', { _kind: step.kind, _rows: step.rows });
    const current = totals[step.kind] ?? { received: 0, inserted: 0, updated: 0, unresolved: [], skipped: [] };
    const saved = new Set(result?.saved_rows ?? []);
    current.received += result?.received ?? step.rows.length;
    current.inserted += result?.inserted ?? 0;
    current.updated += result?.updated ?? 0;
    current.unresolved.push(...(result?.unresolved_rows ?? []));
    if (step.kind !== 'links') current.skipped.push(...step.rows.map((row) => row.legacy_row).filter((row) => !saved.has(row)));
    totals[step.kind] = current;
    sent += step.rows.length;
    onProgress?.({ sent, total, kind: step.kind });
  }
  return totals;
}

export function useLedgerImportLock() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (locked) => rpc('ledger_import_lock', { _locked: Boolean(locked) }),
    onSuccess: () => client.invalidateQueries({ queryKey: ledgerKeys.root }),
  });
}

export function useRefreshLedger() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: ledgerKeys.root });
}
