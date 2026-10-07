import React, { useEffect, useMemo, useState } from 'react';
import { useIsMutating, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, History, Trash2 } from 'lucide-react';
import { usePermissions } from '../auth/usePermissions';
import { usePayrollRuns, useDeletePayrollRun } from '../data/payroll';
import { hasPayrollSessionChanges } from '../lib/usePayrollSessionState';
import { btnClass } from './ui/Btn';
import ConfirmDialog from './ui/ConfirmDialog';
import ListSearch from './ui/ListSearch';
import Pagination, { usePagination } from './ui/Pagination';
import { SkeletonRows } from './ui/Skeleton';

const INPUT = 'w-full rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-xs text-neutral-800 focus:outline-none focus:border-brand/60 disabled:opacity-60 dark:border-neutral-850 dark:bg-neutral-900 dark:text-neutral-200';
const money = value => value == null ? '—' : `₹${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const statusClass = status => status === 'Published' || status === 'Paid'
  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-400'
  : 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-400';
const inputSave = mutation => ['save-payroll-monthly-inputs', 'save-payroll-policy', 'save-salary-structure', 'run-payroll', 'publish-payroll', 'save-payroll-adjustment', 'delete-payroll-adjustment', 'create-payroll-advance', 'void-payroll-advance', 'save-payroll-advance-recovery', 'set-payroll-payment-status'].includes(mutation.options.mutationKey?.[0]);
const EMPTY_RUNS = [];

export default function PayrollHistory({ onBusyChange }) {
  const client = useQueryClient();
  const { can } = usePermissions();
  const runsQuery = usePayrollRuns();
  const runs = runsQuery.data ?? EMPTY_RUNS;
  const remove = useDeletePayrollRun();
  const activeInputSaves = useIsMutating({ predicate: inputSave });
  const [search, setSearch] = useState('');
  const [entityId, setEntityId] = useState('');
  const [period, setPeriod] = useState('');
  const [status, setStatus] = useState('');
  const [draftToDelete, setDraftToDelete] = useState(null);
  const [notice, setNotice] = useState('');

  useEffect(() => { onBusyChange?.(remove.isPending); }, [remove.isPending, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  const companies = useMemo(() => [...new Map(runs.filter(run => run.entity_id).map(run => [run.entity_id, {
    id: run.entity_id, label: run.entity?.name || run.entity?.code || 'Company unavailable',
  }])).values()].sort((a, b) => a.label.localeCompare(b.label)), [runs]);
  const matching = runs.filter(run => (!entityId || run.entity_id === entityId)
    && (!period || run.period === period) && (!status || run.status === status)
    && `${run.period} ${run.entity?.code ?? ''} ${run.entity?.name ?? ''} ${run.status}`.toLowerCase().includes(search.trim().toLowerCase()));
  const pager = usePagination(matching, 10, null, JSON.stringify([search, entityId, period, status]));
  const filtersActive = Boolean(search || entityId || period || status);
  const hasChanges = run => hasPayrollSessionChanges(client, run.entity_id, run.period);
  const canDelete = run => run.status === 'Draft' && can('payroll.manage', { entityId: run.entity_id });
  const deleteBlocked = run => remove.isPending || runsQuery.isFetching || Boolean(runsQuery.error)
    || activeInputSaves > 0 || hasChanges(run);

  return <div className="space-y-4">
    <section className="premium-card space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold text-neutral-900 dark:text-white"><History size={17} className="text-brand-ink" />Payroll history</h2>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">Open a previous month to review its register or continue a draft.</p>
        </div>
        {!runsQuery.isLoading && !runsQuery.error && <div className="flex flex-wrap gap-2 text-xs" aria-label="Payroll history summary">
          <span className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300"><b>{runs.filter(run => run.status === 'Draft').length}</b> drafts</span>
          <span className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300"><b>{runs.filter(run => run.status === 'Published' || run.status === 'Paid').length}</b> published</span>
        </div>}
      </div>
      <fieldset disabled={remove.isPending} className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="min-w-0 sm:col-span-2 xl:col-span-1"><ListSearch value={search} onChange={setSearch} label="Search payroll runs" placeholder="Search company or month…" /></div>
        <select aria-label="Filter payroll history company" className={INPUT} value={entityId} onChange={event => setEntityId(event.target.value)}>
          <option value="">All companies</option>
          {companies.map(company => <option key={company.id} value={company.id}>{company.label}</option>)}
        </select>
        <input aria-label="Filter payroll history month" type="month" className={INPUT} value={period} onChange={event => setPeriod(event.target.value)} />
        <select aria-label="Filter payroll history status" className={INPUT} value={status} onChange={event => setStatus(event.target.value)}>
          <option value="">All statuses</option><option value="Draft">Draft</option><option value="Published">Published</option><option value="Paid">Paid</option>
        </select>
      </fieldset>
      {filtersActive && <button type="button" disabled={remove.isPending} className={btnClass('ghost', 'sm')} onClick={() => { setSearch(''); setEntityId(''); setPeriod(''); setStatus(''); }}>Clear filters</button>}
      {notice && <p role="status" className="text-xs text-emerald-700 dark:text-emerald-300">{notice}</p>}
      {runsQuery.error && <p role="alert" className="flex items-start gap-2 text-xs text-rose-600 dark:text-rose-400"><AlertTriangle size={14} className="shrink-0" />{runsQuery.error.message}</p>}
      {runsQuery.isLoading ? <SkeletonRows rows={4} /> : runsQuery.error ? null : matching.length === 0 ? <div className="py-10 text-center">
        <p className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">{filtersActive ? 'No payroll matches these filters.' : 'No payroll has been calculated yet.'}</p>
        <p className="mt-1 text-xs text-neutral-500">{filtersActive ? 'Clear a filter to see more months.' : 'Prepare your first month in Run Payroll.'}</p>
      </div> : <div className="space-y-2">
        {pager.slice.map(run => {
          const unsaved = hasChanges(run);
          return <article key={run.id} className="mobile-list-row flex flex-wrap items-center justify-between gap-4 rounded-xl border border-neutral-200/70 px-4 py-4 dark:border-neutral-850">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-bold text-neutral-900 dark:text-white">{run.period} · {run.entity?.code || run.entity?.name || 'Company unavailable'}</h3>
                <span className={`rounded px-2 py-1 text-2xs font-bold uppercase ${statusClass(run.status)}`}>{run.status}</span>
              </div>
              <p className="mt-1 text-xs text-neutral-500">{run.employees} employees · Net pay <span className="font-semibold tabular-nums text-neutral-700 dark:text-neutral-200">{money(run.total_net)}</span></p>
              {run.needs_recalculation && run.status === 'Draft' && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Inputs changed. Recalculate this draft before publishing.</p>}
              {!run.source_fingerprint && run.status === 'Draft' && !run.needs_recalculation && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Recalculate this draft to prepare its register.</p>}
              {unsaved && run.status === 'Draft' && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Unsaved changes are kept for this company. Continue the draft to save or discard them.</p>}
            </div>
            <div className="mobile-list-actions flex items-center gap-2">
              <Link to={`/payroll/run?entity=${encodeURIComponent(run.entity_id)}&period=${encodeURIComponent(run.period)}&step=review`} className={btnClass('ghost')}
                aria-disabled={remove.isPending || undefined} tabIndex={remove.isPending ? -1 : undefined} onClick={event => { if (remove.isPending) event.preventDefault(); }}>
                {run.status === 'Draft' ? 'Continue draft' : 'View register'}<ArrowRight size={13} />
              </Link>
              {canDelete(run) && <button type="button" className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-lg border border-neutral-200 text-neutral-400 transition-colors hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-800 dark:hover:border-rose-900/60 dark:hover:bg-rose-950/30"
                disabled={deleteBlocked(run)} title={unsaved ? 'Save or discard the retained changes before deleting this draft' : 'Delete draft payroll'} aria-label={`Delete ${run.period} draft payroll for ${run.entity?.name || run.entity?.code || 'this company'}`}
                onClick={() => { if (deleteBlocked(run)) return; remove.reset(); setNotice(''); setDraftToDelete(run); }}><Trash2 size={14} /></button>}
            </div>
          </article>;
        })}
      </div>}
    </section>
    {!runsQuery.error && <Pagination {...pager} noun="payroll runs" sizes={[10, 25, 50]} disabled={remove.isPending} />}
    {draftToDelete && <ConfirmDialog title="Delete draft payroll?" confirmLabel="Delete draft" busy={remove.isPending} error={remove.error?.message}
      onCancel={() => { remove.reset(); setDraftToDelete(null); }}
      onConfirm={async () => {
        const current = client.getQueryData(['payroll-runs'])?.find(run => run.id === draftToDelete.id);
        if (!current || !canDelete(current)) throw new Error('This payroll is no longer an editable draft. Refresh payroll history.');
        if (deleteBlocked(current) || client.isMutating({ predicate: inputSave })) throw new Error('Save or discard payroll changes and wait for pending saves before deleting this draft.');
        try {
          await remove.mutateAsync(current.id);
          setNotice(`${current.period} draft payroll deleted.`);
          setDraftToDelete(null);
        } catch { /* The mutation error remains visible in the dialog. */ }
      }}>
      <p>The <b>{draftToDelete.period}</b> draft for <b>{draftToDelete.entity?.name || draftToDelete.entity?.code || 'this company'}</b> and its generated draft payslips will be removed.</p>
      <p className="text-neutral-500 dark:text-neutral-400">You can calculate this month again. Published payroll cannot be deleted.</p>
    </ConfirmDialog>}
  </div>;
}
