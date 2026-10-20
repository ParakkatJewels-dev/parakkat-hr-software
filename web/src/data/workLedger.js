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
  report: (owner, period, date) => ['work-ledger', 'report', owner ?? 'me', period, date ?? null],
};

async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data;
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

export async function fetchLedgerExport() {
  const rows = await rpc('ledger_export_tasks');
  return Array.isArray(rows) ? rows : [];
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
