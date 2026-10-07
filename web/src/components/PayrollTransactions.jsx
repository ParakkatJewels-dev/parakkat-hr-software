import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useIsMutating, useQueryClient } from '@tanstack/react-query';
import { Banknote, Check, ChevronRight, CreditCard, Loader2, LockKeyhole, Pencil, Plus, Trash2, Users } from 'lucide-react';
import {
  usePayrollAdjustments, usePayrollAdvances, usePayrollAdvanceRecoveries, usePayrollPayments,
  useSavePayrollAdjustment, useDeletePayrollAdjustment, useCreatePayrollAdvance,
  useSavePayrollAdvanceRecovery, useSetPayrollPaymentStatus, useVoidPayrollAdvance,
} from '../data/payrollTransactions';
import { usePayrollMonthlyInputs } from '../data/payrollWorksheet';
import { todayIso } from '../data/attendance';
import {
  normalizePayrollAdjustment, normalizePayrollAdvance, normalizePayrollAdvanceRecovery,
  normalizePayrollPaymentStatus, payrollAdvanceBalance,
} from '../lib/payrollTransactions';
import { usePayrollSessionState } from '../lib/usePayrollSessionState';
import { useRevealOnOpen } from '../lib/useRevealOnOpen';
import { btnClass } from './ui/Btn';
import { FormError } from './ui/FormSection';
import ConfirmDialog from './ui/ConfirmDialog';
import ListSearch from './ui/ListSearch';
import Pagination, { usePagination } from './ui/Pagination';
import './payrollTransactions.css';

const EMPTY = [];
const ENTRY_LABELS = { bonus: 'Bonus', incentive: 'Incentive', deduction: 'Deduction' };
const money = value => `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const errorText = error => error?.message || String(error || '');
const queryBlocked = query => !query.isSuccess || query.isFetching || Boolean(query.error);
const freshQueryBlocked = (client, key) => {
  const state = client.getQueryState(key);
  return !state || state.status !== 'success' || state.fetchStatus === 'fetching' || Boolean(state.error);
};
const transactionWrite = mutation => [
  'save-payroll-adjustment', 'delete-payroll-adjustment', 'create-payroll-advance',
  'save-payroll-advance-recovery', 'void-payroll-advance', 'set-payroll-payment-status', 'save-payroll-monthly-inputs',
  'save-payroll-policy', 'save-salary-structure', 'run-payroll', 'publish-payroll',
].includes(mutation.options.mutationKey?.[0]);
const blankEntry = () => ({ kind: 'bonus', amount: '', reason: '' });
const blankAdvance = () => ({ issuedOn: todayIso(), amount: '', reason: '' });
const emptySession = () => ({ selectedId: '', tab: 'entries', entry: null, advance: null, recoveries: {}, payment: null, voidAdvance: null, dirty: false });
const draftChanged = entry => Boolean(entry && !same(entry.draft, entry.baseline));
const workbenchDirty = state => draftChanged(state.entry) || draftChanged(state.advance) || Object.keys(state.recoveries || {}).length > 0 || Boolean(state.voidAdvance?.reason?.trim());
const withDirty = state => ({ ...state, dirty: Boolean(workbenchDirty(state) || draftChanged(state.payment)) });
const defaultPayment = record => ({ status: record?.status || 'unpaid', hold_reason: record?.hold_reason || '', payment_reference: record?.payment_reference || '' });
const newId = () => globalThis.crypto.randomUUID();

function useTransactionSession(entityId, period, onDirtyChange, onBusyChange, busy) {
  const [state, setState] = usePayrollSessionState(['transactions', entityId, period], emptySession);
  const update = next => setState(current => withDirty(typeof next === 'function' ? next(current) : next));
  useEffect(() => { onDirtyChange?.(Boolean(state.dirty)); }, [state.dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  useEffect(() => {
    if (!state.dirty && !busy) return undefined;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [state.dirty, busy]);
  return [state, update];
}

function Loading({ children = 'Loading saved entries…' }) {
  return <p className="ptx-help ptx-loading" role="status"><Loader2 size={14} className="animate-spin" />{children}</p>;
}
function Notice({ children }) { return children ? <p className="ptx-notice" role="status">{children}</p> : null; }
function Field({ label, children, hint, className = '' }) {
  return <label className={`ptx-field ${className}`}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
function EmployeeHeading({ person, children }) {
  return <div className="ptx-heading"><div><h4>{person.full_name}</h4><p>{[person.employee_code, person.branch?.name || person.branch?.code].filter(Boolean).join(' · ')}</p></div>{children}</div>;
}

/** Itemized payroll entries and issued advances, always scoped to the supplied employee roster. */
export default function PayrollTransactions({ entityId, period, employees = EMPTY, run, disabled = false, published = false, onDirtyChange, onBusyChange }) {
  const client = useQueryClient();
  const adjustments = usePayrollAdjustments(entityId, period);
  const advances = usePayrollAdvances(entityId);
  const recoveries = usePayrollAdvanceRecoveries(entityId);
  const monthlyInputs = usePayrollMonthlyInputs(entityId, period);
  const saveEntry = useSavePayrollAdjustment();
  const deleteEntry = useDeletePayrollAdjustment();
  const createAdvance = useCreatePayrollAdvance();
  const voidAdvance = useVoidPayrollAdvance();
  const saveRecovery = useSavePayrollAdvanceRecovery();
  const activeWrites = useIsMutating({ predicate: transactionWrite });
  const writeLock = useRef(false);
  const [working, setWorking] = useState(false);
  const busy = working || activeWrites > 0 || saveEntry.isPending || deleteEntry.isPending || createAdvance.isPending || voidAdvance.isPending || saveRecovery.isPending;
  const [state, update] = useTransactionSession(entityId, period, onDirtyChange, onBusyChange, busy);
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState(null);
  const [discardAction, setDiscardAction] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [issueConfirmation, setIssueConfirmation] = useState(null);
  const chosen = employees.find(person => person.id === state.selectedId);
  const filtered = employees.filter(person => `${person.full_name || ''} ${person.employee_code || ''} ${person.branch?.name || ''}`.toLowerCase().includes(search.trim().toLowerCase()));
  const pager = usePagination(filtered, 10, null, search);
  const editorRef = useRevealOnOpen(Boolean(chosen), { key: chosen?.id });
  const locked = published || ['Published', 'Paid'].includes(run?.status);
  const commonBlocked = disabled || busy || !entityId || !period || !chosen;
  const entryBlocked = commonBlocked || locked || queryBlocked(adjustments);
  const advanceBlocked = commonBlocked || [advances, recoveries, monthlyInputs].some(queryBlocked);
  const savedEntries = (adjustments.data || EMPTY).filter(row => row.employee_id === chosen?.id);
  const employeeAdvances = (advances.data || EMPTY).filter(row => row.employee_id === chosen?.id)
    .sort((a, b) => (b.issued_on || '').localeCompare(a.issued_on || ''));
  const employeeRecoveries = (recoveries.data || EMPTY).filter(row => row.employee_id === chosen?.id);
  const manualRecovery = Number((monthlyInputs.data || EMPTY).find(row => row.employee_id === chosen?.id)?.advance_recovery || 0);
  const entryForm = state.entry?.draft || blankEntry();
  const advanceForm = state.advance?.draft || blankAdvance();
  const currentEntry = state.entry?.expectedUpdatedAt ? (adjustments.data || EMPTY).find(row => row.id === state.entry.id) : null;
  const entryConflict = Boolean(state.entry?.expectedUpdatedAt && currentEntry?.updated_at !== state.entry.expectedUpdatedAt);
  const entryDirty = draftChanged(state.entry);
  const advanceDirty = draftChanged(state.advance);
  const balanceResult = useMemo(() => {
    try {
      return { values: new Map((advances.data || EMPTY).map(advance => [advance.id, payrollAdvanceBalance(advance, recoveries.data || EMPTY)])) };
    } catch (reason) { return { error: reason, values: new Map() }; }
  }, [advances.data, recoveries.data]);

  const clearError = () => { setError(null); setNotice(''); };
  const perform = async operation => {
    if (writeLock.current || client.isMutating({ predicate: transactionWrite })) return false;
    writeLock.current = true; setWorking(true); onBusyChange?.(true); setError(null);
    try { await operation(); return true; }
    catch (reason) { setError(reason); return false; }
    finally { writeLock.current = false; setWorking(false); onBusyChange?.(false); }
  };
  const askDiscard = (execute, hasDraft = workbenchDirty(state)) => {
    if (busy) return;
    if (hasDraft) setDiscardAction({ execute }); else execute();
  };
  const choose = person => {
    if (person.id === state.selectedId) return;
    askDiscard(() => {
      update(current => ({ ...current, selectedId: person.id, entry: null, advance: null, recoveries: {}, voidAdvance: null })); clearError();
    });
  };
  const editEntry = row => askDiscard(() => {
    const draft = { kind: row.kind, amount: String(row.amount), reason: row.reason || '' };
    update(current => ({ ...current, entry: { id: row.id, expectedUpdatedAt: row.updated_at, draft, baseline: draft } })); clearError();
    editorRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, entryDirty);
  const patchEntry = patch => {
    clearError();
    update(current => {
      const value = current.entry || { id: newId(), expectedUpdatedAt: null, baseline: blankEntry(), draft: blankEntry() };
      return { ...current, entry: { ...value, draft: { ...value.draft, ...patch } } };
    });
  };
  const patchAdvance = patch => {
    clearError();
    update(current => {
      const base = blankAdvance();
      const value = current.advance || { requestId: newId(), baseline: base, draft: base };
      return { ...current, advance: { ...value, draft: { ...value.draft, ...patch } } };
    });
  };
  const submitEntry = async event => {
    event.preventDefault();
    if (entryBlocked || entryConflict || !entryDirty || freshQueryBlocked(client, ['payroll-adjustments', entityId, period])) return;
    const value = state.entry;
    const latest = client.getQueryData(['payroll-adjustments', entityId, period])?.find(row => row.id === value.id);
    if (value.expectedUpdatedAt && latest?.updated_at !== value.expectedUpdatedAt) { setError(new Error('This entry changed. Reload it before saving.')); return; }
    const ok = await perform(async () => {
      const adjustment = normalizePayrollAdjustment(value.draft);
      await saveEntry.mutateAsync({ employeeId: chosen.id, period, adjustment, id: value.id, expectedUpdatedAt: value.expectedUpdatedAt });
      update(current => ({ ...current, entry: null }));
      setNotice(`${ENTRY_LABELS[adjustment.kind]} saved for ${chosen.full_name}. Recalculate payroll to include it.`);
    });
    return ok;
  };
  const reviewAdvance = event => {
    event.preventDefault();
    if (advanceBlocked || !advanceDirty) return;
    try { setIssueConfirmation({ ...normalizePayrollAdvance(state.advance.draft), requestId: state.advance.requestId, employeeId: chosen.id, employeeName: chosen.full_name }); setError(null); }
    catch (reason) { setError(reason); }
  };
  const patchRecovery = (advance, record, amount) => {
    clearError();
    update(current => {
      const next = { ...current.recoveries };
      const baseline = record ? String(record.amount) : '0';
      const value = next[advance.id] || { baseline, expectedUpdatedAt: record?.updated_at || null };
      if (amount.trim() !== '' && Number(amount) === Number(value.baseline)) delete next[advance.id];
      else next[advance.id] = { ...value, amount };
      return { ...current, recoveries: next };
    });
  };
  const submitRecovery = async (advance, balance) => {
    if (locked || advance.voided_at) return;
    const draft = state.recoveries[advance.id];
    if (!draft || advanceBlocked || balanceResult.error) return;
    if ([['payroll-advances', entityId], ['payroll-advance-recoveries', entityId], ['payroll-monthly-inputs', entityId, period]].some(key => freshQueryBlocked(client, key))) return;
    await perform(async () => {
      const value = normalizePayrollAdvanceRecovery({ period, amount: draft.amount });
      const saved = (client.getQueryData(['payroll-advance-recoveries', entityId]) || EMPTY).find(row => row.advance_id === advance.id && row.period === period);
      if (saved?.posted) throw new Error('This recovery belongs to published payroll and cannot be changed.');
      if ((saved?.updated_at || null) !== draft.expectedUpdatedAt) throw new Error('This recovery changed. Reload its saved amount before saving.');
      if (value.amount > 0 && manualRecovery > 0) throw new Error('Clear the manual Salary advance refund in monthly inputs before planning a ledger recovery.');
      if (value.amount > Number(balance.available) + Number(saved?.amount || 0)) throw new Error('Recovery exceeds the balance available after other planned months.');
      await saveRecovery.mutateAsync({ advanceId: advance.id, period, amount: value.amount, expectedUpdatedAt: draft.expectedUpdatedAt });
      update(current => { const next = { ...current.recoveries }; delete next[advance.id]; return { ...current, recoveries: next }; });
      setNotice(value.amount ? `Recovery of ${money(value.amount)} planned for ${period}. It becomes recovered when payroll is published.` : `Recovery removed from ${period}.`);
    });
  };

  return <section className="payroll-transactions premium-card" aria-label="Employee payroll entries">
    <div className="ptx-heading"><div><h3><Banknote size={16} />Employee entries & advances</h3><p>Add a bonus, incentive or deduction with a reason. Track issued advances and plan repayments.</p></div>
      <span className="ptx-period">{period}{locked ? ' · Monthly payroll locked' : ''}</span></div>
    <Notice>{notice}</Notice>
    <FormError message={error} />
    {locked && <p className="ptx-help"><LockKeyhole size={13} />Published monthly entries and recoveries are read-only. You can still record or correct unused advances.</p>}
    <div className="ptx-workspace">
      <aside className="ptx-roster" aria-label="Choose payroll employee">
        <ListSearch value={search} onChange={setSearch} label="Search employees for payroll entries" placeholder="Name, code or branch…" />
        <p className="ptx-help">{filtered.length} employees</p>
        <div className="ptx-people">{pager.slice.map(person => <button key={person.id} type="button" disabled={busy} aria-pressed={chosen?.id === person.id}
          onClick={() => choose(person)} className="ptx-person"><span><strong>{person.full_name}</strong><small>{person.employee_code || 'No code'}{person.branch?.code ? ` · ${person.branch.code}` : ''}</small></span><ChevronRight size={13} /></button>)}</div>
        {!filtered.length && <p className="ptx-empty">No employees match this search.</p>}
        <Pagination {...pager} noun="employees" sizes={[10, 25, 50]} disabled={busy} />
      </aside>
      <div className="ptx-detail" ref={editorRef}>
        {!chosen ? <div className="ptx-placeholder"><Users size={25} /><h4>Select an employee</h4><p>Search by name or employee code to manage their entries and advances.</p>
          {state.dirty && <button type="button" disabled={busy} className={btnClass('ghost', 'sm')} onClick={() => askDiscard(() => update(current => ({ ...current, selectedId: '', entry: null, advance: null, recoveries: {}, voidAdvance: null })))}>Discard unavailable employee draft</button>}
        </div> : <>
          <EmployeeHeading person={chosen} />
          <div className="ptx-tabs" aria-label="Employee entry views">
            <button type="button" disabled={busy} aria-pressed={state.tab !== 'advances'} onClick={() => update(current => ({ ...current, tab: 'entries' }))}>Monthly entries{entryDirty ? ' •' : ''}</button>
            <button type="button" disabled={busy} aria-pressed={state.tab === 'advances'} onClick={() => update(current => ({ ...current, tab: 'advances' }))}>Advances & recovery{advanceDirty || Object.keys(state.recoveries).length ? ' •' : ''}</button>
          </div>
          {state.tab !== 'advances' ? <>
            <FormError message={adjustments.error} />
            {adjustments.isLoading ? <Loading /> : !adjustments.error && <>
              {!locked && <form className="ptx-form" onSubmit={submitEntry}>
                <div className="ptx-heading"><h5>{state.entry?.expectedUpdatedAt ? 'Edit saved entry' : 'Add monthly entry'}</h5>{entryDirty && <span className="ptx-help">Unsaved</span>}</div>
                <fieldset disabled={entryBlocked || entryConflict} className="ptx-form-grid">
                  <Field label="Type"><select value={entryForm.kind} onChange={event => patchEntry({ kind: event.target.value })}>{Object.entries(ENTRY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
                  <Field label="Amount (₹)"><input type="number" min="0.01" max="99999999.99" step="0.01" inputMode="decimal" required value={entryForm.amount} onChange={event => patchEntry({ amount: event.target.value })} placeholder="0.00" /></Field>
                  <Field label="Reason" className="ptx-full"><input required maxLength={500} value={entryForm.reason} onChange={event => patchEntry({ reason: event.target.value })} placeholder="e.g. September sales target achieved" /></Field>
                </fieldset>
                {entryConflict && <p className="ptx-warning">This entry changed after you opened it. Discard this edit and reopen the saved entry.</p>}
                <div className="ptx-actions"><button type="submit" disabled={entryBlocked || entryConflict || !entryDirty} className={btnClass('primary', 'sm')}>{saveEntry.isPending ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}Save entry</button>
                  {state.entry && <button type="button" disabled={busy} className={btnClass('ghost', 'sm')} onClick={() => { update(current => ({ ...current, entry: null })); clearError(); }}>Discard edit</button>}</div>
              </form>}
              <div className="ptx-heading"><h5>Saved entries · {period}</h5><span className="ptx-help">{savedEntries.length} items</span></div>
              {!savedEntries.length ? <p className="ptx-empty">No itemized entries this month.</p> : <div className="ptx-entry-list">{savedEntries.map(row => <article key={row.id} className="ptx-entry"><div><span className={`ptx-badge ${row.kind === 'deduction' ? 'ptx-badge-warning' : ''}`}>{ENTRY_LABELS[row.kind] || row.kind}</span><p>{row.reason}</p></div>
                <strong className="ptx-money">{row.kind === 'deduction' ? '−' : '+'}{money(row.amount)}</strong>
                {!locked && <div className="ptx-actions"><button type="button" className={btnClass('ghost', 'sm', true)} disabled={entryBlocked} aria-label={`Edit ${ENTRY_LABELS[row.kind] || 'entry'}: ${row.reason}`} onClick={() => editEntry(row)}><Pencil size={13} /></button>
                  <button type="button" className={btnClass('dangerGhost', 'sm', true)} disabled={entryBlocked || (state.entry?.id === row.id && entryDirty)} aria-label={`Delete ${ENTRY_LABELS[row.kind] || 'entry'}: ${row.reason}`} onClick={() => { deleteEntry.reset(); setDeleteTarget(row); }}><Trash2 size={13} /></button></div>}
              </article>)}</div>}
              <p className="ptx-help">These entries are added to the saved monthly inputs when payroll is calculated. Avoid entering the same amount in both places.</p>
            </>}
          </> : <>
            <FormError message={advances.error || recoveries.error || monthlyInputs.error || balanceResult.error} />
            {[advances, recoveries, monthlyInputs].some(query => query.isLoading) ? <Loading>Loading advance balances…</Loading> : <>
              <form onSubmit={reviewAdvance} className="ptx-form">
                <div className="ptx-heading"><h5>Issue a salary advance</h5>{advanceDirty && <span className="ptx-help">Unsaved</span>}</div>
                <fieldset disabled={advanceBlocked} className="ptx-form-grid">
                  <Field label="Issued on"><input type="date" required value={advanceForm.issuedOn} onChange={event => patchAdvance({ issuedOn: event.target.value })} /></Field>
                  <Field label="Advance amount (₹)"><input type="number" min="0.01" max="99999999.99" step="0.01" required inputMode="decimal" value={advanceForm.amount} onChange={event => patchAdvance({ amount: event.target.value })} placeholder="0.00" /></Field>
                  <Field label="Reason" className="ptx-full"><input required maxLength={500} value={advanceForm.reason} onChange={event => patchAdvance({ reason: event.target.value })} placeholder="Reason for issuing the advance" /></Field>
                </fieldset>
                <p className="ptx-help">Advances are employee records across all months. Record money issued outside payroll, then plan recovery in an unpublished month.</p>
                <div className="ptx-actions"><button type="submit" disabled={advanceBlocked || !advanceDirty} className={btnClass('primary', 'sm')}><Plus size={13} />Review advance</button>
                  {state.advance && <button type="button" disabled={busy} className={btnClass('ghost', 'sm')} onClick={() => { update(current => ({ ...current, advance: null })); clearError(); }}>Discard advance</button>}</div>
              </form>
              {manualRecovery > 0 && <p className="ptx-warning">Monthly inputs already contain a manual Salary advance refund of {money(manualRecovery)}. Clear it before adding an advance recovery here.</p>}
              <div className="ptx-heading"><h5>Advance balances</h5><span className="ptx-help">{employeeAdvances.length} advances</span></div>
              {!employeeAdvances.length && !advances.error && <p className="ptx-empty">No advances have been issued to this employee.</p>}
              {employeeAdvances.map(advance => {
                const balance = balanceResult.values.get(advance.id);
                if (!balance) return null;
                const record = employeeRecoveries.find(row => row.advance_id === advance.id && row.period === period);
                const draft = state.recoveries[advance.id];
                const conflict = draft && draft.expectedUpdatedAt !== (record?.updated_at || null);
                const tooEarly = advance.issued_on?.slice(0, 7) > period;
                const shownAmount = draft?.amount ?? (record ? String(record.amount) : '0');
                return <article key={advance.id} className="ptx-advance">
                  <div className="ptx-heading"><div><h5>{money(advance.amount)} · {advance.issued_on}</h5><p>{advance.reason}</p></div></div>
                  {advance.voided_at && <p className="ptx-warning">Voided · {advance.void_reason}</p>}
                  <dl className="ptx-balances"><div><dt>Issued</dt><dd>{money(balance.issued)}</dd></div><div><dt>Recovered</dt><dd>{money(balance.recovered)}</dd></div><div><dt>Remaining</dt><dd>{money(balance.outstanding)}</dd></div><div><dt>Planned · all months</dt><dd>{money(balance.scheduled)}</dd></div></dl>
                  {locked || record?.posted ? <p className="ptx-help">Recovered in {period}: <strong>{money(record?.amount)}</strong></p> : <div className="ptx-recovery">
                    <Field label={`Recovery in ${period} (₹)`} hint={tooEarly ? 'This advance was issued after the selected month.' : `Available for this month: ${money(balance.available + Number(record?.amount || 0))}. Enter 0 to remove.`}>
                      <input type="number" aria-label={`Recovery for advance issued ${advance.issued_on} (${money(advance.amount)})`} min="0" max={balance.available + Number(record?.amount || 0)} step="0.01" inputMode="decimal" disabled={advanceBlocked || locked || record?.posted || advance.voided_at || tooEarly || Boolean(balanceResult.error)} value={shownAmount} onChange={event => patchRecovery(advance, record, event.target.value)} />
                    </Field>
                    <div className="ptx-actions"><button type="button" className={btnClass('primary', 'sm')} disabled={advanceBlocked || locked || record?.posted || advance.voided_at || !draft || conflict || tooEarly || Boolean(balanceResult.error) || (manualRecovery > 0 && Number(shownAmount) > 0)} onClick={() => submitRecovery(advance, balance)}>Save recovery</button>
                      {draft && <button type="button" className={btnClass('ghost', 'sm')} disabled={busy} onClick={() => update(current => { const next = { ...current.recoveries }; delete next[advance.id]; return { ...current, recoveries: next }; })}>{conflict ? 'Reload saved amount' : 'Discard'}</button>}</div>
                    {conflict && <p className="ptx-warning">The saved recovery changed. Reload it before saving.</p>}
                  </div>}
                  {!advance.voided_at && !employeeRecoveries.some(row => row.advance_id === advance.id) && <div className="ptx-actions"><button type="button" className={btnClass('dangerGhost', 'sm')} disabled={advanceBlocked || Boolean(state.recoveries[advance.id])} onClick={() => { update(current => ({ ...current, voidAdvance: { id: advance.id, expectedUpdatedAt: advance.updated_at, amount: advance.amount, reason: '' } })); voidAdvance.reset(); setError(null); }}>Void unused advance</button></div>}
                  <details className="ptx-recovery-history"><summary>Recovery history</summary>{employeeRecoveries.filter(row => row.advance_id === advance.id).sort((a, b) => b.period.localeCompare(a.period)).map(row => <p key={row.id}><span>{row.period} · {row.posted ? 'Recovered' : 'Planned'}</span><strong>{money(row.amount)}</strong></p>)}
                    {!employeeRecoveries.some(row => row.advance_id === advance.id) && <p>No recoveries planned yet.</p>}</details>
                </article>;
              })}
              <p className="ptx-help">Remaining is issued minus recovered. Draft plans reserve a balance; publication books the recovery.</p>
            </>}
          </>}
        </>}
      </div>
    </div>
    {discardAction && <ConfirmDialog title="Discard employee entry changes?" confirmLabel="Discard changes" cancelLabel="Keep editing" onCancel={() => setDiscardAction(null)} onConfirm={() => { discardAction.execute(); setDiscardAction(null); }}><p>Your unsaved entry, advance or recovery changes will be discarded.</p></ConfirmDialog>}
    {deleteTarget && <ConfirmDialog title="Delete payroll entry?" confirmLabel="Delete entry" busy={deleteEntry.isPending || working} error={errorText(deleteEntry.error || error)} onCancel={() => { setDeleteTarget(null); deleteEntry.reset(); setError(null); }} onConfirm={async () => {
      if (entryBlocked || freshQueryBlocked(client, ['payroll-adjustments', entityId, period])) return;
      const latest = client.getQueryData(['payroll-adjustments', entityId, period])?.find(row => row.id === deleteTarget.id);
      if (!latest || latest.updated_at !== deleteTarget.updated_at) throw new Error('This entry changed or was removed. Refresh the saved entries before deleting.');
      if (await perform(async () => { await deleteEntry.mutateAsync({ id: latest.id, expectedUpdatedAt: latest.updated_at }); update(current => ({ ...current, entry: current.entry?.id === latest.id ? null : current.entry })); setNotice('Payroll entry deleted. Recalculate the draft to update totals.'); })) setDeleteTarget(null);
    }}><p>{chosen?.full_name} · {ENTRY_LABELS[deleteTarget.kind]} · {money(deleteTarget.amount)}</p><p>{deleteTarget.reason}</p></ConfirmDialog>}
    {state.voidAdvance && <ConfirmDialog title="Void unused advance?" confirmLabel="Void advance" busy={voidAdvance.isPending || working} error={errorText(voidAdvance.error || error)}
      onCancel={() => { update(current => ({ ...current, voidAdvance: null })); setError(null); voidAdvance.reset(); }} onConfirm={async () => {
        if (advanceBlocked || [ ['payroll-advances', entityId], ['payroll-advance-recoveries', entityId] ].some(key => freshQueryBlocked(client, key))) return;
        const target = state.voidAdvance;
        const latest = client.getQueryData(['payroll-advances', entityId])?.find(row => row.id === target.id);
        if (!latest || latest.voided_at || latest.updated_at !== target.expectedUpdatedAt) throw new Error('This advance changed. Reload its saved record before voiding.');
        if ((client.getQueryData(['payroll-advance-recoveries', entityId]) || EMPTY).some(row => row.advance_id === target.id)) throw new Error('Clear every draft recovery before voiding. An advance with published recovery cannot be voided.');
        if (!target.reason.trim()) throw new Error('Enter a reason for voiding this advance.');
        await perform(async () => { await voidAdvance.mutateAsync({ id: target.id, reason: target.reason.trim(), expectedUpdatedAt: target.expectedUpdatedAt }); update(current => ({ ...current, voidAdvance: null })); setNotice('Unused advance voided. Its original record remains in the history.'); });
      }}><p>{chosen?.full_name} · {money(state.voidAdvance.amount)}</p><p>Only an advance without recoveries can be voided. This corrects the record; it does not move money.</p>
      <Field label="Reason for voiding"><input required maxLength={500} disabled={busy} value={state.voidAdvance.reason} onChange={event => update(current => ({ ...current, voidAdvance: { ...current.voidAdvance, reason: event.target.value } }))} /></Field>
    </ConfirmDialog>}
    {issueConfirmation && <ConfirmDialog title="Record this issued advance?" tone="primary" confirmLabel="Record issued advance" busy={createAdvance.isPending || working} error={errorText(createAdvance.error || error)} onCancel={() => { setIssueConfirmation(null); createAdvance.reset(); setError(null); }} onConfirm={async () => {
      if (advanceBlocked || issueConfirmation.employeeId !== chosen?.id || freshQueryBlocked(client, ['payroll-advances', entityId])) return;
      if (await perform(async () => { await createAdvance.mutateAsync(issueConfirmation); update(current => ({ ...current, advance: null })); setNotice(`Advance of ${money(issueConfirmation.amount)} recorded. Plan a recovery below.`); })) setIssueConfirmation(null);
    }}><p><b>{issueConfirmation.employeeName}</b> · {money(issueConfirmation.amount)} · {issueConfirmation.issuedOn}</p><p>{issueConfirmation.reason}</p><p>This records money already issued to the employee. It does not transfer money or deduct the full advance from this payroll.</p></ConfirmDialog>}
  </section>;
}

/** Payment tracking follows published register rows; these actions never initiate bank transfers. */
export function PayrollPayments({ entityId, period, employees = EMPTY, run, registerRows = EMPTY, disabled = false, published = false, onDirtyChange, onBusyChange }) {
  const client = useQueryClient();
  const isPublished = published || ['Published', 'Paid'].includes(run?.status);
  const payments = usePayrollPayments(run?.id, { enabled: isPublished });
  const save = useSetPayrollPaymentStatus();
  const activeWrites = useIsMutating({ predicate: transactionWrite });
  const writeLock = useRef(false);
  const [working, setWorking] = useState(false);
  const busy = working || activeWrites > 0 || save.isPending;
  const [state, update] = useTransactionSession(entityId, period, onDirtyChange, onBusyChange, busy);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState(null);
  const [paidConfirmation, setPaidConfirmation] = useState(null);
  const [discardTarget, setDiscardTarget] = useState(null);
  const paidMap = new Map((payments.data || EMPTY).map(row => [row.employee_id, row]));
  const people = new Map(employees.map(person => [person.id, person]));
  const rows = registerRows.map(row => ({ ...row, person: people.get(row.employee_id), payment: paidMap.get(row.employee_id),
    name: row.payroll_register?.employee_name || row.employee?.full_name || people.get(row.employee_id)?.full_name || 'Employee',
    code: row.payroll_register?.employee_code || row.employee?.employee_code || people.get(row.employee_id)?.employee_code || '', net: row.net ?? row.payroll_register?.net_pay_salary }));
  const filtered = rows.filter(row => (!status || (row.payment?.status || 'unpaid') === status)
    && `${row.name} ${row.code} ${row.payroll_register?.branch || ''}`.toLowerCase().includes(search.trim().toLowerCase()));
  const pager = usePagination(filtered, 25, null, `${search}:${status}`);
  const selection = rows.find(row => row.employee_id === state.payment?.employeeId);
  const blocked = disabled || busy || !isPublished || !run?.id || queryBlocked(payments);
  const draft = state.payment;
  const conflict = Boolean(draft && (paidMap.get(draft.employeeId)?.updated_at || null) !== draft.expectedUpdatedAt);
  const editorRef = useRevealOnOpen(Boolean(selection && draft), { key: draft ? `${draft.employeeId}:${draft.target}` : null });
  const counts = rows.reduce((total, row) => { total[row.payment?.status || 'unpaid'] += 1; return total; }, { unpaid: 0, held: 0, paid: 0 });

  const openPayment = (row, target) => {
    const set = () => {
      const baseline = { reason: '', reference: '' };
      update(current => ({ ...current, payment: { employeeId: row.employee_id, target, expectedUpdatedAt: row.payment?.updated_at || null, baseline, draft: baseline } }));
      setNotice(''); setError(null); save.reset();
    };
    if (draftChanged(state.payment)) setDiscardTarget({ execute: set }); else set();
  };
  const patch = change => update(current => ({ ...current, payment: { ...current.payment, draft: { ...current.payment.draft, ...change } } }));
  const persistPayment = async ({ employeeId, target, expectedUpdatedAt, reason, reference }) => {
    if (blocked || writeLock.current || client.isMutating({ predicate: transactionWrite }) || freshQueryBlocked(client, ['payroll-payments', run.id])) return false;
    const latest = client.getQueryData(['payroll-payments', run.id])?.find(row => row.employee_id === employeeId);
    if ((latest?.updated_at || null) !== expectedUpdatedAt) { setError(new Error('Payment status changed. Reload it before saving.')); return false; }
    if (latest?.status === 'paid') { setError(new Error('This payment is already recorded as paid.')); return false; }
    if (target === 'paid' && latest?.status === 'held') { setError(new Error('Release the payment hold before recording payment.')); return false; }
    writeLock.current = true; setWorking(true); onBusyChange?.(true); setError(null);
    try {
      const payment = normalizePayrollPaymentStatus({ status: target, reason, reference });
      await save.mutateAsync({ runId: run.id, employeeId, ...payment, expectedUpdatedAt });
      update(current => ({ ...current, payment: null }));
      const person = rows.find(row => row.employee_id === employeeId);
      setNotice(`${person?.name || 'Employee'}: ${target === 'held' ? 'payment put on hold.' : target === 'paid' ? 'payment recorded.' : 'hold released; payment is unpaid.'}`);
      return true;
    } catch (reason) { setError(reason); return false; }
    finally { writeLock.current = false; setWorking(false); onBusyChange?.(false); }
  };
  const submit = async event => {
    event.preventDefault();
    if (!selection || !draft || blocked || conflict) return;
    try {
      normalizePayrollPaymentStatus({ status: draft.target, ...draft.draft });
      if (draft.target === 'paid') setPaidConfirmation({ ...draft, name: selection.name, net: selection.net });
      else await persistPayment({ ...draft, ...draft.draft });
    } catch (reason) { setError(reason); }
  };

  if (!isPublished) return null;
  return <section className="payroll-transactions premium-card" aria-label="Published payroll payments">
    <div className="ptx-heading"><div><h3><CreditCard size={16} />Payment status</h3><p>Record completed payments or hold an employee’s payment. These actions do not transfer money.</p></div><span className="ptx-period">{period}</span></div>
    <Notice>{notice}</Notice><FormError message={payments.error || error} />
    {payments.isLoading ? <Loading>Loading payment status…</Loading> : !payments.error && <>
      <div className="ptx-payment-counts"><span>{counts.unpaid} unpaid</span><span>{counts.held} on hold</span><span>{counts.paid} paid</span></div>
      {draft && selection && <form ref={editorRef} onSubmit={submit} className="ptx-form">
        <div className="ptx-heading"><div><h4>{draft.target === 'paid' ? 'Record payment' : 'Hold payment'} · {selection.name}</h4><p>Net salary {money(selection.net)}</p></div></div>
        {draft.target === 'paid' ? <Field label="Payment reference"><input required maxLength={200} disabled={blocked || conflict} value={draft.draft.reference} onChange={event => patch({ reference: event.target.value })} placeholder="Bank transfer / transaction reference" /></Field>
          : <Field label="Hold reason"><input required maxLength={500} disabled={blocked || conflict} value={draft.draft.reason} onChange={event => patch({ reason: event.target.value })} placeholder="Why is this payment being held?" /></Field>}
        {conflict && <p className="ptx-warning">The saved payment status changed. Discard this form and reopen the latest status.</p>}
        <div className="ptx-actions"><button type="submit" className={btnClass('primary', 'sm')} disabled={blocked || conflict}>{draft.target === 'paid' ? 'Review payment record' : 'Save payment hold'}</button>
          <button type="button" className={btnClass('ghost', 'sm')} disabled={busy} onClick={() => { update(current => ({ ...current, payment: null })); setError(null); }}>Discard</button></div>
      </form>}
      {draft && !selection && <p className="ptx-warning">This employee is no longer in the loaded register. <button type="button" className={btnClass('ghost', 'sm')} disabled={busy} onClick={() => update(current => ({ ...current, payment: null }))}>Discard payment draft</button></p>}
      <div className="ptx-payment-filters"><ListSearch value={search} onChange={setSearch} label="Search payroll payments" placeholder="Employee name or code…" />
        <Field label="Payment status"><select value={status} onChange={event => setStatus(event.target.value)}><option value="">All statuses</option><option value="unpaid">Unpaid</option><option value="held">On hold</option><option value="paid">Paid</option></select></Field></div>
      <div className="ptx-payment-table" tabIndex={0} aria-label="Payroll payment status table"><table><thead><tr><th>Employee</th><th>Net salary</th><th>Payment status</th><th>Reason / reference</th><th>Action</th></tr></thead><tbody>{pager.slice.map(row => {
        const payment = defaultPayment(row.payment);
        return <tr key={row.employee_id}><td><strong>{row.name}</strong><small>{row.code}</small></td><td className="ptx-money">{money(row.net)}</td><td><span className={`ptx-badge ${payment.status === 'held' ? 'ptx-badge-warning' : payment.status === 'paid' ? 'ptx-badge-paid' : ''}`}>{payment.status === 'held' ? 'On hold' : payment.status === 'paid' ? 'Paid' : 'Unpaid'}</span></td>
          <td className="ptx-payment-reason">{payment.status === 'held' ? payment.hold_reason : payment.status === 'paid' ? payment.payment_reference : '—'}{row.payment?.paid_at && <small>{new Date(row.payment.paid_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}</small>}</td>
          <td><div className="ptx-actions">{payment.status === 'held' ? <button type="button" className={btnClass('ghost', 'sm')} disabled={blocked || draftChanged(state.payment)} onClick={() => persistPayment({ employeeId: row.employee_id, target: 'unpaid', expectedUpdatedAt: row.payment.updated_at, reason: '', reference: '' })}>Release hold</button>
            : payment.status === 'paid' ? <span className="ptx-help"><Check size={13} />Recorded</span> : <><button type="button" className={btnClass('ghost', 'sm')} disabled={blocked} onClick={() => openPayment(row, 'held')}>Hold</button><button type="button" className={btnClass('primary', 'sm')} disabled={blocked || row.net == null || !Number.isFinite(Number(row.net))} onClick={() => openPayment(row, 'paid')}>Record paid</button></>}</div></td></tr>;
      })}</tbody></table></div>
      {!filtered.length && <p className="ptx-empty">{rows.length ? 'No payments match these filters.' : 'No employees are available in this published register.'}</p>}
      <Pagination {...pager} noun="employees" disabled={busy} />
    </>}
    {discardTarget && <ConfirmDialog title="Discard payment changes?" confirmLabel="Discard changes" cancelLabel="Keep editing" onCancel={() => setDiscardTarget(null)} onConfirm={() => { discardTarget.execute(); setDiscardTarget(null); }}><p>The current payment reason or reference has not been saved.</p></ConfirmDialog>}
    {paidConfirmation && <ConfirmDialog title="Record this salary as paid?" tone="primary" confirmLabel="Record paid" busy={save.isPending || working} error={errorText(save.error || error)} onCancel={() => { setPaidConfirmation(null); save.reset(); setError(null); }} onConfirm={async () => {
      if (await persistPayment({ ...paidConfirmation, ...paidConfirmation.draft })) setPaidConfirmation(null);
    }}><p><b>{paidConfirmation.name}</b> · {money(paidConfirmation.net)} · {period}</p><p>Reference: {paidConfirmation.draft.reference}</p><p>Confirm the payment has already been completed. This records its status and cannot be changed here. It does not send a bank transfer.</p></ConfirmDialog>}
  </section>;
}
