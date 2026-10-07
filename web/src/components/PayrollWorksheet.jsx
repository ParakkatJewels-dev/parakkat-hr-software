import React, { useEffect, useMemo, useState } from 'react';
import { useIsMutating, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, ArrowRight, Check, Download, Loader2, LockKeyhole, Play } from 'lucide-react';
import { usePermissions } from '../auth/usePermissions';
import { useEmployees } from '../data/employees';
import { useVisibleOrg } from '../data/org';
import { todayIso } from '../data/attendance';
import {
  usePayrollPolicy, usePayrollWorksheetRun, usePayrollRegister,
  useSavePayrollPolicy, usePayrollMonthlyInputs, usePayrollAttendanceSummary,
} from '../data/payrollWorksheet';
import {
  payrollRegisterColumns, payrollPolicyDraft, formatPayrollDayHours,
  isCompletePayrollRegister, exportPayrollRegister,
} from '../lib/payrollWorksheet';
import { btnClass } from './ui/Btn';
import Pagination, { usePagination } from './ui/Pagination';
import ListSearch from './ui/ListSearch';
import { hasPayrollSessionChanges, usePayrollSessionState } from '../lib/usePayrollSessionState';
import PayrollInputGrid from './PayrollInputGrid';
import PayrollSheetFrame from './PayrollSheetFrame';
import PayrollTransactions, { PayrollPayments } from './PayrollTransactions';
import { usePayrollAdjustments, usePayrollAdvanceRecoveries } from '../data/payrollTransactions';
import { useRunPayroll, usePublishPayroll } from '../data/payroll';
import ConfirmDialog from './ui/ConfirmDialog';
import './payrollWorkflow.css';

const INPUT = 'w-full text-xs rounded-xl px-3 py-2 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-brand/60 disabled:opacity-60';
const LABEL = 'block text-xs font-medium text-neutral-600 dark:text-neutral-300 space-y-1';
const HELP = 'text-xs text-neutral-500 dark:text-neutral-400';
const TITLE = 'text-sm font-bold text-neutral-800 dark:text-neutral-100';
const EMPTY_ROWS = [];
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

function ErrorMessage({ error }) {
  return error ? <p role="alert" className="flex items-start gap-2 text-xs text-rose-600 dark:text-rose-400">
    <AlertTriangle size={14} className="shrink-0" />{error.message || String(error)}
  </p> : null;
}

function Loading({ children }) {
  return <p role="status" className={`flex items-center gap-2 ${HELP}`}><Loader2 size={14} className="animate-spin" />{children}</p>;
}

// Keep a typed draft when a background read fails or refreshes. An incoming change cannot
// silently overwrite it, and a stale draft cannot silently overwrite another operator's save.
function useWorksheetDraft(record, toDraft, entityId) {
  const [state, setState] = usePayrollSessionState(['policy', entityId], () => ({
    baseline: JSON.stringify(record ?? null), draft: toDraft(record), dirty: false,
  }));
  const { baseline, draft, dirty } = state;
  const incoming = JSON.stringify(record ?? null);
  useEffect(() => {
    if (!dirty && incoming !== baseline) setState({ baseline: incoming, draft: toDraft(record), dirty: false });
  }, [record, toDraft, dirty, incoming, baseline, setState]);
  const reset = () => setState({ baseline: incoming, draft: toDraft(record), dirty: false });
  return { draft, dirty, changed: dirty && incoming !== baseline, reset,
    patch: (key, value) => setState(current => ({ ...current, draft: { ...current.draft, [key]: value }, dirty: true })),
    saved: () => setState(current => ({ ...current, dirty: false })) };
}

export default function PayrollWorksheet({ onDirtyChange, onBusyChange }) {
  const { can, canAny } = usePermissions();
  const allowed = canAny('payroll.manage');
  const [params, setParams] = useSearchParams();
  const [context, setContext] = usePayrollSessionState(['context'], () => ({
    // Only a company in the scoped entity list below can open queries or actions.
    entityId: params.get('entity') || '',
    period: monthPattern.test(params.get('period') ?? '') ? params.get('period') : todayIso().slice(0, 7),
  }));
  const routeEntity = params.get('entity');
  const routePeriod = params.get('period');
  useEffect(() => {
    if (routeEntity) setContext(current => ({ ...current, entityId: routeEntity,
      ...(monthPattern.test(routePeriod ?? '') ? { period: routePeriod } : {}) }));
  }, [routeEntity, routePeriod, setContext]);
  const { entityId, period } = context;
  const [inputBusy, setInputBusy] = useState(false);
  const [policyBusy, setPolicyBusy] = useState(false);
  const busy = inputBusy || policyBusy;
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  const [inputDirty, setInputDirty] = useState(false);
  const [policyDirty, setPolicyDirty] = useState(false);
  const [transactionDirty, setTransactionDirty] = useState(false);
  const dirty = inputDirty || policyDirty || transactionDirty;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, busy]);
  const changeContext = change => {
    if (busy) return;
    const next = { ...context, ...change };
    setContext(next);
    const query = new URLSearchParams(params);
    if (next.entityId) query.set('entity', next.entityId); else query.delete('entity');
    query.set('period', next.period); query.delete('step');
    setParams(query, { replace: true });
  };
  const org = useVisibleOrg();
  const employees = useEmployees({ enabled: allowed });
  const managedEmployees = useMemo(() => (employees.data ?? []).filter(employee => can('payroll.manage', {
    entityId: employee.entity_id, zoneId: employee.zone_id, branchId: employee.branch_id,
    deptId: employee.department_id, employeeId: employee.id,
  })), [employees.data, can]);
  const entities = (org.data?.entities ?? []).filter(entity => can('payroll.manage', { entityId: entity.id })
    || managedEmployees.some(employee => employee.entity_id === entity.id));
  const entity = entities.find(candidate => candidate.id === entityId);

  if (!allowed) return <p className={HELP}>Payroll management permission is required to view the worksheet.</p>;
  return <div className="payroll-workflow space-y-4">
    <section className="premium-card payroll-context">
      <div>
        <p className="payroll-eyebrow">MONTHLY PAYROLL</p>
        <h2 className="text-lg font-bold text-neutral-900 dark:text-white">Run monthly payroll</h2>
        <p className={`${HELP} mt-1`}>Choose the company and month once, then work through the steps below.</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className={LABEL}><span>Company</span>
          <select className={INPUT} value={entityId} onChange={event => changeContext({ entityId: event.target.value })} disabled={busy || org.isLoading || employees.isLoading}>
            <option value="">Choose a company…</option>
            {entities.map(item => <option key={item.id} value={item.id}>{item.code} — {item.name}</option>)}
          </select>
        </label>
        <label className={LABEL}><span>Payroll month</span>
          <input type="month" disabled={busy} className={INPUT} value={period} onChange={event => {
            if (monthPattern.test(event.target.value)) changeContext({ period: event.target.value });
          }} />
        </label>
      </div>
      <ErrorMessage error={org.error || employees.error} />
      {(org.isLoading || employees.isLoading) && <Loading>Loading companies and employees…</Loading>}
      {entityId && !entity && !org.isLoading && !employees.isLoading && !org.error && !employees.error
        && <p className={HELP}>This company is not available in your payroll scope. Choose a company from the list.</p>}
    </section>
    {!entity && !org.isLoading && !employees.isLoading && <section className="premium-card payroll-start">
      <div className="payroll-start-icon"><Play size={24} /></div>
      <h3 className={TITLE}>Start with a company and payroll month</h3>
      <p className={HELP}>Prepare employee inputs, review calculated salaries, and release payslips from this workspace.</p>
      <div className="payroll-start-path"><span>1 · Prepare data</span><ArrowRight size={14} /><span>2 · Review payroll</span><ArrowRight size={14} /><span>3 · Publish</span></div>
    </section>}
    {entity && <CompanyWorksheet key={`${entity.id}:${period}`} entity={entity} period={period}
      employees={managedEmployees.filter(employee => employee.entity_id === entity.id)}
      canManageCompany={can('payroll.manage', { entityId: entity.id })} onInputDirtyChange={setInputDirty} onPolicyDirtyChange={setPolicyDirty} onInputBusyChange={setInputBusy} onPolicyBusyChange={setPolicyBusy} inputBusy={inputBusy} scopeReadBlocked={org.isFetching || employees.isFetching || Boolean(org.error || employees.error)} inputsDirty={dirty} onTransactionDirtyChange={setTransactionDirty} />}

  </div>;
}

const FLOW_STEPS = [
  { id: 'prepare', label: 'Prepare data', detail: 'Policy & monthly inputs' },
  { id: 'review', label: 'Review payroll', detail: 'Calculate & check salaries' },
  { id: 'publish', label: 'Publish & payments', detail: 'Payslips, holds & paid status' },
];
const payrollWrite = mutation => ['save-payroll-monthly-inputs', 'save-payroll-policy', 'save-salary-structure', 'run-payroll', 'publish-payroll', 'save-payroll-adjustment', 'delete-payroll-adjustment', 'create-payroll-advance', 'void-payroll-advance', 'save-payroll-advance-recovery', 'set-payroll-payment-status'].includes(mutation.options.mutationKey?.[0]);
const rupees = value => value == null ? '—' : `₹${Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

function CompanyWorksheet({ entity, period, employees, canManageCompany, onInputDirtyChange, onPolicyDirtyChange, onInputBusyChange, onPolicyBusyChange, inputBusy, scopeReadBlocked, inputsDirty, onTransactionDirtyChange }) {
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [prepareView, setPrepareView] = usePayrollSessionState(['prepare-view', entity.id, period], 'sheet');
  const [savedStep, setSavedStep] = usePayrollSessionState(['step', entity.id, period], 'prepare');
  const routeStep = params.get('step');
  const step = FLOW_STEPS.some(item => item.id === routeStep) ? routeStep : savedStep;
  const changeStep = next => {
    if (busy) return;
    setSavedStep(next);
    const query = new URLSearchParams(params);
    query.set('entity', entity.id); query.set('period', period); query.set('step', next);
    setParams(query, { replace: true });
  };
  const policy = usePayrollPolicy(entity.id);
  const runQuery = usePayrollWorksheetRun(entity.id, period);
  const run = runQuery.data;
  const register = usePayrollRegister(run?.id, { enabled: runQuery.isSuccess });
  const inputs = usePayrollMonthlyInputs(entity.id, period);
  const adjustments = usePayrollAdjustments(entity.id, period);
  const recoveries = usePayrollAdvanceRecoveries(entity.id);
  const transactionsReadBlocked = [adjustments, recoveries].some(query => !query.isSuccess || query.isFetching || query.error);
  const published = run?.status === 'Published' || run?.status === 'Paid';
  const attendance = usePayrollAttendanceSummary(entity.id, period, { enabled: !published });
  const runPayroll = useRunPayroll();
  const publish = usePublishPayroll();
  const [confirmPublish, setConfirmPublish] = useState(null);
  const activeSaves = useIsMutating({ predicate: payrollWrite });
  const busy = inputBusy || activeSaves > 0 || runPayroll.isPending || publish.isPending;
  useEffect(() => { onPolicyBusyChange?.(busy); return () => onPolicyBusyChange?.(false); }, [busy, onPolicyBusyChange]);
  const pending = inputsDirty || hasPayrollSessionChanges(client, entity.id, period);
  const runReadBlocked = !runQuery.isSuccess || runQuery.isFetching || Boolean(runQuery.error);
  const rows = register.data ?? EMPTY_ROWS;
  const registerReady = Boolean(run && register.isSuccess && !register.isFetching && !register.error && rows.length
    && rows.every(row => isCompletePayrollRegister(row.payroll_register))
    && (!canManageCompany || Number(run.employees) === rows.length) && (published || (!run.needs_recalculation && run.source_fingerprint)));
  const paymentsReady = Boolean(published && register.isSuccess && !register.isFetching && !register.error && rows.length
    && rows.every(row => row.status === 'Published' && ['number', 'string'].includes(typeof row.net) && String(row.net).trim() !== '' && Number.isFinite(Number(row.net)) && Number(row.net) >= 0)
    && (!canManageCompany || Number(run.employees) === rows.length));
  const futureMonth = period > todayIso().slice(0, 7);
  const calculateBlocked = futureMonth || !canManageCompany || published || busy || pending || scopeReadBlocked || runReadBlocked
    || !policy.isSuccess || policy.isFetching || !policy.data || Boolean(policy.error)
    || !inputs.isSuccess || inputs.isFetching || Boolean(inputs.error)
    || !attendance.isSuccess || attendance.isFetching || Boolean(attendance.error) || transactionsReadBlocked;
  const publishBlocked = !canManageCompany || published || busy || pending || scopeReadBlocked || runReadBlocked || transactionsReadBlocked || !registerReady;
  const attendanceIssues = (attendance.data ?? []).filter(row => row.in_payroll_month !== false && (row.employment_issue || row.override_issue
    || Number(row.missing_days) > 0 || Number(row.unresolved_days) > 0 || Number(row.invalid_days) > 0 || Number(row.pending_recompute_days) > 0)).length;
  const contextQuery = `entity=${encodeURIComponent(entity.id)}&period=${encodeURIComponent(period)}`;
  const continueBlocked = busy || pending || runReadBlocked || scopeReadBlocked;
  const continueReview = () => {
    if (continueBlocked || client.isMutating({ predicate: payrollWrite }) || hasPayrollSessionChanges(client, entity.id, period)) return;
    changeStep('review');
  };
  const calculate = async () => {
    if (calculateBlocked || client.isMutating({ predicate: payrollWrite }) || hasPayrollSessionChanges(client, entity.id, period)) return;
    try {
      await runPayroll.mutateAsync({ entity_id: entity.id, period });
      changeStep('review');
    } catch { /* the error stays beside the action */ }
  };
  const calculation = <button type="button" className={btnClass(registerReady ? 'ghost' : 'primary')} disabled={calculateBlocked} onClick={calculate}>
    {runPayroll.isPending ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}{run ? 'Recalculate payroll' : 'Calculate payroll'}
  </button>;

  return <>
    <nav className="payroll-steps" aria-label="Monthly payroll steps">
      {FLOW_STEPS.map((item, index) => <button type="button" key={item.id} onClick={() => changeStep(item.id)} disabled={busy}
        aria-current={step === item.id ? 'step' : undefined}>
        <span className="payroll-step-number">{published ? <Check size={15} /> : index + 1}</span>
        <span><strong>{item.label}</strong><small>{item.detail}</small></span>
      </button>)}
    </nav>
    {published && <div className="payroll-complete" role="status"><LockKeyhole size={18} /><div><strong>{period} payroll is published</strong><p>Inputs and salary calculations are read-only. Track salary holds and completed payments in Publish & payments.</p></div></div>}
    {pending && <p role="status" className="payroll-flow-notice">You have unsaved changes. Save or discard them in Prepare data or Salary setup before calculating, exporting or publishing.</p>}
    {futureMonth && <p className="payroll-flow-notice">Plan adjustments and advance repayments for this month now. Payroll calculation becomes available when the month starts.</p>}
    <ErrorMessage error={runQuery.error} />
    {runQuery.isLoading && <Loading>Loading this payroll month…</Loading>}
    {step === 'prepare' && <>
      <div className="payroll-section-heading"><div><h3 className={TITLE}>1. Prepare monthly data</h3><p className={`${HELP} mt-1`}>Salary and attendance carry forward automatically. Enter only this month’s additions or overrides.</p></div>
        <Link className={btnClass('ghost')} to={`/payroll/salary?${contextQuery}`}>Manage salaries<ArrowRight size={13} /></Link>
      </div>
      <details className="premium-card space-y-3" open={!policy.data || undefined}>
        <summary className={`${TITLE} cursor-pointer`}>Company calculation policy
          <span className="font-normal text-xs text-neutral-500 ml-2">{policy.data ? `Saved · ${policy.data.divisor_mode} days · ${formatPayrollDayHours(policy.data.hours_per_day)} / day · ${policy.data.ot_multiplier}× OT` : 'Set up once before calculating'}</span>
        </summary>
        <ErrorMessage error={policy.error} />
        {policy.isLoading ? <Loading>Loading saved policy…</Loading> : policy.isSuccess || policy.data !== undefined ?
          <PolicyEditor entityId={entity.id} record={policy.data} onDirtyChange={onPolicyDirtyChange} disabled={scopeReadBlocked || published || runReadBlocked || busy || policy.isFetching || Boolean(policy.error) || !canManageCompany} /> : null}
        {!canManageCompany && <p className={HELP}>A company payroll manager saves policy and runs payroll. You can prepare the employees within your scope.</p>}
      </details>
      <div className="payroll-prepare-tabs" role="group" aria-label="Prepare payroll view">
        <button type="button" disabled={busy} aria-pressed={prepareView === 'sheet'} onClick={() => setPrepareView('sheet')}>Monthly inputs</button>
        <button type="button" disabled={busy} aria-pressed={prepareView === 'entries'} onClick={() => setPrepareView('entries')}>Adjustments & advances</button>
      </div>
      {prepareView === 'sheet' ? <PayrollInputGrid entityId={entity.id} companyName={entity.name} period={period} employees={employees} published={published}
        disabled={runReadBlocked || scopeReadBlocked || busy} snapshots={rows} onDirtyChange={onInputDirtyChange} onBusyChange={onInputBusyChange}
        onContinue={continueReview} continueDisabled={continueBlocked} />
        : <PayrollTransactions entityId={entity.id} period={period} employees={employees} run={run} registerRows={rows} published={published}
          disabled={runReadBlocked || scopeReadBlocked || busy} onDirtyChange={onTransactionDirtyChange} onBusyChange={onInputBusyChange} />}
      {prepareView !== 'sheet' && <div className="premium-card payroll-flow-footer"><p className={HELP}>{pending ? 'Save your changes above to continue.' : 'Monthly inputs ready? Continue to calculate and review salaries.'}</p>
        <button type="button" className={btnClass('primary')} disabled={continueBlocked} onClick={continueReview}>Continue to review<ArrowRight size={14} /></button>
      </div>}
    </>}
    {step === 'review' && <>
      <section className="premium-card space-y-4">
        <div className="payroll-section-heading"><div><h3 className={TITLE}>2. Calculate and review payroll</h3><p className={`${HELP} mt-1`}>{entity.name} · {period}. Check employee totals before releasing payslips.</p></div>
          {!published && calculation}
        </div>
        {!published && <div className="payroll-readiness">
          <div><span>Company policy</span><strong>{policy.data ? 'Saved' : 'Setup required'}</strong></div>
          <div><span>Monthly inputs</span><strong>{pending ? 'Unsaved changes' : !inputs.isSuccess || inputs.error ? 'Unavailable' : `${inputs.data?.length ?? 0} saved rows`}</strong></div>
          <div><span>Attendance</span><strong>{!attendance.isSuccess || attendance.error ? 'Unavailable' : attendanceIssues ? `${attendanceIssues} need review` : 'Loaded from attendance'}</strong></div>
        </div>}
        {!published && !policy.data && <p className="payroll-flow-notice">Save the company calculation policy in Prepare data before calculating.</p>}
        {!published && attendanceIssues > 0 && <p className={HELP}>Review attendance issues in Prepare data. Calculation will report any records that must be corrected.</p>}
        {!canManageCompany && <p className={HELP}>A company payroll manager must calculate and publish this month.</p>}
        <ErrorMessage error={runPayroll.error || (!published && (policy.error || inputs.error || attendance.error || adjustments.error || recoveries.error))} />
        {runPayroll.isPending && <Loading>Calculating salary from saved inputs and attendance…</Loading>}
        {run && <PayrollTotals run={run} />}
      </section>
      <Register entity={entity} period={period} runQuery={runQuery} registerQuery={register} canManageCompany={canManageCompany} inputsDirty={pending} processing={busy} />
      <div className="premium-card payroll-flow-footer"><button type="button" className={btnClass('ghost')} disabled={busy} onClick={() => changeStep('prepare')}><ArrowLeft size={14} />Back to inputs</button>
        {published ? <Link className={btnClass('primary')} to={`/payroll/payslips?${contextQuery}`}>View payslips<ArrowRight size={14} /></Link> : <button type="button" className={btnClass('primary')} disabled={publishBlocked} onClick={() => changeStep('publish')}>Continue to publish<ArrowRight size={14} /></button>}
      </div>
    </>}
    {step === 'publish' && <section className="premium-card space-y-4">
      <div><h3 className={TITLE}>{published ? 'Salary payments' : '3. Publish reviewed payroll'}</h3><p className={`${HELP} mt-1`}>{entity.name} · {period}</p></div>
      {run && <PayrollTotals run={run} />}
      {!published && <>
        <p className="text-sm text-neutral-700 dark:text-neutral-300">Publishing releases payslips to employees and locks this payroll and its attendance. Check the register and approved adjustments before proceeding.</p>
        <p className={HELP}>After publishing, hold or release an employee’s salary and record completed payments here. Bank transfers are made separately.</p>
        {!registerReady && <p role="alert" className="payroll-flow-notice">Calculate and review a complete, up-to-date register before publishing.</p>}
        {run?.needs_recalculation && <p className={HELP}>Inputs changed. Return to Review payroll and recalculate this draft.</p>}
        <ErrorMessage error={register.error} />
      </>}
      <div className="payroll-flow-footer"><button type="button" className={btnClass('ghost')} disabled={busy} onClick={() => changeStep('review')}><ArrowLeft size={14} />Back to register</button>
        {published ? <Link className={btnClass('primary')} to={`/payroll/payslips?${contextQuery}`}>View payslips<ArrowRight size={14} /></Link>
          : <button type="button" className={btnClass('primary')} disabled={publishBlocked} onClick={() => { publish.reset(); setConfirmPublish(run); }}><Check size={14} />Publish payroll</button>}
      </div>
    </section>}
    {step === 'publish' && published && <PayrollPayments entityId={entity.id} period={period} employees={employees} run={run} registerRows={rows} published
      disabled={scopeReadBlocked || runReadBlocked || !paymentsReady || busy} onDirtyChange={onTransactionDirtyChange} onBusyChange={onInputBusyChange} />}
    {step === 'publish' && published && !paymentsReady && <p role="alert" className="payroll-flow-notice">Payment actions require a complete, successfully loaded set of published payslip amounts. Refresh this payroll before recording a payment.</p>}
    {confirmPublish && <ConfirmDialog title="Publish reviewed payroll?" tone="primary" confirmLabel="Publish payroll" busy={publish.isPending} error={publish.error?.message}
      onCancel={() => { publish.reset(); setConfirmPublish(null); }} onConfirm={async () => {
        if (publishBlocked || client.isMutating({ predicate: payrollWrite }) || hasPayrollSessionChanges(client, entity.id, period)) return;
        try { await publish.mutateAsync({ runId: confirmPublish.id, expectedFingerprint: confirmPublish.source_fingerprint }); setConfirmPublish(null); }
        catch { /* keep the confirmation open with its error */ }
      }}>
      <p>{entity.name} · {period} · {confirmPublish.employees} employees</p>
      <p>Net pay <b>{rupees(confirmPublish.total_net)}</b>. This releases employee payslips and locks the month.</p>
    </ConfirmDialog>}
  </>;
}

function PayrollTotals({ run }) {
  return <dl className="payroll-totals">
    <div><dt>Employees in payroll</dt><dd>{run.employees}</dd></div>
    <div><dt>Gross pay</dt><dd>{rupees(run.total_gross)}</dd></div>
    <div><dt>Net pay</dt><dd>{rupees(run.total_net)}</dd></div>
    <div><dt>Status</dt><dd className="payroll-total-status">{run.needs_recalculation && run.status === 'Draft' ? 'Recalculate' : run.status}</dd></div>
  </dl>;
}

function DraftConflict({ changed, reset }) {
  return changed ? <div className="space-y-2 text-xs text-amber-700 dark:text-amber-300" role="alert">
    <p>Saved values changed while you were editing. Reload them before saving another change.</p>
    <button type="button" className={btnClass('ghost')} onClick={reset}>Reload saved values</button>
  </div> : null;
}

function PolicyEditor({ entityId, record, disabled, onDirtyChange, onBusyChange }) {
  const editor = useWorksheetDraft(record, payrollPolicyDraft, entityId);
  const save = useSavePayrollPolicy();
  const activeSaves = useIsMutating({ mutationKey: ['save-payroll-policy'], predicate: mutation => mutation.state.variables?.entityId === entityId });
  const saving = save.isPending || activeSaves > 0;
  useEffect(() => { onBusyChange?.(saving); }, [saving, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  useEffect(() => { onDirtyChange?.(editor.dirty || saving); }, [editor.dirty, saving, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const [success, setSuccess] = useState(false);
  const blocked = disabled || saving || editor.changed;
  const patch = (key, value) => { editor.patch(key, value); save.reset(); setSuccess(false); };
  return <form className="space-y-3" onSubmit={async event => {
    event.preventDefault();
    if (blocked) return;
    setSuccess(false);
    try { await save.mutateAsync({ entityId, policy: editor.draft, expectedUpdatedAt: record?.updated_at ?? null }); editor.saved(); setSuccess(true); }
    catch { /* shown below without clearing typed values */ }
  }}>
    {!record && <p className="text-xs text-amber-700 dark:text-amber-300">No reviewed policy has been saved. Daily working time starts at 8h 30m. Review the salary divisor and OT rules, then save your company’s policy before running payroll.</p>}
    <fieldset disabled={blocked} className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <label className={LABEL}><span>Salary divisor</span><select className={INPUT} value={editor.draft.divisor_mode} onChange={event => patch('divisor_mode', event.target.value)}>
          <option value="calendar">Calendar days in the month</option><option value="fixed">Fixed days</option><option value="working">Scheduled working days</option>
        </select></label>
        <label className={LABEL}><span>Fixed days</span><input type="number" className={INPUT} min="1" max="31" step="0.01" disabled={editor.draft.divisor_mode !== 'fixed'} value={editor.draft.fixed_days} onChange={event => patch('fixed_days', event.target.value)} /></label>
        <label className={LABEL}><span id="payroll-daily-hours-label">Daily working hours (decimal)</span><input required type="number" className={INPUT} min="0.01" max="24" step="0.01" aria-labelledby="payroll-daily-hours-label" aria-describedby="payroll-daily-hours-help" value={editor.draft.hours_per_day} onChange={event => patch('hours_per_day', event.target.value)} />
          <span className="block font-normal text-neutral-500 dark:text-neutral-400" id="payroll-daily-hours-help"><strong className="font-medium">{formatPayrollDayHours(editor.draft.hours_per_day)} per day.</strong> Enter 8.5 for 8h 30m; 8.3 means 8h 18m.</span>
        </label>
        <label className={LABEL}><span>OT hourly multiplier</span><input required type="number" className={INPUT} min="0" max="10" step="0.01" value={editor.draft.ot_multiplier} onChange={event => patch('ot_multiplier', event.target.value)} /></label>
      </div>
      <label className="flex items-center gap-2 text-xs text-neutral-700 dark:text-neutral-300"><input type="checkbox" checked={editor.draft.deduct_late} onChange={event => patch('deduct_late', event.target.checked)} />Deduct late hours at the calculated hourly rate</label>
      <label className={LABEL}><span>Policy notes</span><textarea className={INPUT} rows={2} value={editor.draft.notes} onChange={event => patch('notes', event.target.value)} placeholder="Record your approved attendance, OT and deduction rules." /></label>
    </fieldset>
    <p className={HELP}>Daily rate = monthly salary ÷ selected divisor. Hourly rate = daily rate ÷ working hours per day. OT amount = OT hours × hourly rate × multiplier. Late amount is deducted only when enabled.</p>
    <p className={HELP}>{editor.draft.divisor_mode === 'fixed'
      ? 'For a fixed divisor, earned salary = monthly salary × max(0, 1 − (unpaid days + calendar days outside employment) ÷ fixed days). A fully paid month receives the full monthly salary.'
      : editor.draft.divisor_mode === 'working'
        ? 'For a working-day divisor, earned salary uses paid scheduled working days. Public holidays and weekly offs do not add another paid day to that divisor.'
        : 'For a calendar divisor, earned salary = monthly salary × paid calendar days ÷ calendar days in the month. Paid leave, public holidays and weekly offs are included once.'}</p>
    <p className={HELP}>Saving a policy marks existing draft runs for recalculation. Published registers keep their saved calculations. PF and ESI use configured pay components or an explicit monthly override.</p>
    <DraftConflict changed={editor.changed} reset={editor.reset} />
    <ErrorMessage error={save.error} />
    <div className="flex flex-wrap items-center gap-3">
      <button className={btnClass('primary')} type="submit" disabled={blocked || Boolean(record && !editor.dirty)}>{saving && <Loader2 size={13} className="animate-spin" />}Save reviewed policy</button>
      {editor.dirty && <button type="button" className={btnClass('ghost')} disabled={saving} onClick={editor.reset}>Discard policy changes</button>}
      {success && <p role="status" className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-300"><Check size={13} />Policy saved. Recalculate affected drafts.</p>}
    </div>
  </form>;
}

function Register({ entity, period, runQuery, registerQuery: register, canManageCompany, inputsDirty, processing = false }) {
  const client = useQueryClient();
  const run = runQuery.data;
  const [search, setSearch] = useState('');
  const [exporting, setExporting] = useState(false);
  const [detailed, setDetailed] = useState(false);
  const columns = payrollRegisterColumns(register.data ?? EMPTY_ROWS);
  const visibleColumns = detailed ? columns : columns.filter(({ key }) => ['employee_name', 'branch', 'salary', 'total_working_hours', 'earned_salary', 'ot_hours', 'late_hours', 'gross_salary', 'net_pay_salary'].includes(key));
  const [exportError, setExportError] = useState(null);
  const rows = register.data ?? EMPTY_ROWS;
  const filtered = useMemo(() => rows.filter(row => `${row.payroll_register?.employee_name ?? ''} ${row.payroll_register?.branch ?? ''}`.toLowerCase().includes(search.trim().toLowerCase())), [rows, search]);
  const pager = usePagination(filtered, 25, null, search);
  const loading = runQuery.isLoading || runQuery.isFetching || Boolean(run && (register.isLoading || register.isFetching));
  const readError = runQuery.error || register.error;
  const incomplete = rows.some(row => !isCompletePayrollRegister(row.payroll_register));
  const countMismatch = canManageCompany && run && register.isSuccess && Number(run.employees) !== rows.length;
  const stale = Boolean(run?.needs_recalculation);
  const calculationPolicy = rows.find(row => row.payroll_register?.policy)?.payroll_register.policy;
  const blocked = processing || inputsDirty || loading || Boolean(readError) || !run || !rows.length || incomplete || countMismatch || stale;
  const format = (value, type) => value == null ? '—' : type === 'text' ? String(value)
    : Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-IN', { minimumFractionDigits: type === 'money' ? 2 : 0, maximumFractionDigits: 2 }) : '—';
  return <PayrollSheetFrame title={`${entity.name} · ${period} · Payroll register`}>{({ control }) => <section className="premium-card space-y-3 min-w-0 payroll-register-workspace">
    {inputsDirty && <p className="text-xs text-amber-700 dark:text-amber-300">This register shows the last saved calculation. Save or discard worksheet changes, then recalculate before exporting.</p>}
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className={TITLE}>Payroll register{run ? ` · ${run.status}` : ''}</h3>
        <p className={`${HELP} mt-1`}>{period} · {entity.code} · {rows.length} visible employees. Amounts are in rupees.</p></div>
      <div className="payroll-input-actions">{control}<button type="button" className={btnClass('ghost')} disabled={blocked || exporting} onClick={async () => {
        if (blocked || client.isMutating({ predicate: payrollWrite })) return;
        setExportError(null); setExporting(true);
        try { await exportPayrollRegister(rows, entity.code, period); }
        catch (error) { setExportError(error); }
        finally { setExporting(false); }
      }}>{exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}Export Excel</button></div>
    </div>
    <p className={HELP}>Review worked hours, payroll OT and late hours alongside salary and take-home pay. Show all columns for the full breakdown. Excel export includes the full breakdown and every employee in your scope.</p>
    {calculationPolicy && !readError && <p className={HELP}>Saved calculation basis: {calculationPolicy.divisor_mode === 'fixed' ? `${calculationPolicy.fixed_days} fixed days` : calculationPolicy.divisor_mode === 'working' ? 'scheduled working days' : 'calendar days'}, {formatPayrollDayHours(calculationPolicy.hours_per_day)} per day, {calculationPolicy.ot_multiplier}× OT. Late deduction {calculationPolicy.deduct_late ? 'enabled' : 'disabled'}. Total Working Hours shows recorded worked hours.</p>}
    <ErrorMessage error={readError || exportError} />
    {loading && <Loading>Loading the saved payroll register…</Loading>}
    {stale && <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">Inputs changed after this draft was calculated. Re-run payroll before reviewing, exporting or publishing these amounts.</p>}
    {incomplete && !loading && !readError && <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">This run has missing or incomplete worksheet snapshots. Recalculate a draft to create its register. Published legacy runs retain their existing payslips.</p>}
    {countMismatch && !loading && !readError && <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">The loaded register does not match the run’s employee count. Refresh the run before exporting.</p>}
    {!run && !loading && !readError && <p className={HELP}>No payroll has been calculated for this company and month. Save the policy and monthly inputs in Prepare data, then calculate payroll above.</p>}
    {run && !loading && !readError && rows.length === 0 && <p className={HELP}>No register rows are available within your scope for this run.</p>}
    {rows.length > 0 && !readError && <>
      <div className="flex flex-wrap items-center gap-3"><div className="flex-1 min-w-48"><ListSearch value={search} onChange={setSearch} label="Search payroll register" placeholder="Search employee or branch…" /></div>
        <button type="button" className={btnClass('ghost')} aria-pressed={detailed} onClick={() => setDetailed(value => !value)}>{detailed ? 'Show salary summary' : `Show all ${columns.length} columns`}</button></div>
      <div className="payroll-register-scroll rounded-xl border border-neutral-200 dark:border-neutral-850" tabIndex={0} aria-label="Payroll register, scroll horizontally for all columns">
        <table className="w-full text-xs text-neutral-700 dark:text-neutral-200">
          <caption className="sr-only">{entity.name} payroll register for {period}{stale ? ', pending recalculation' : ''}</caption>
          <thead className="bg-neutral-50 dark:bg-neutral-900"><tr>{visibleColumns.map(({ key, label, type }) => <th key={key} scope="col" className={`px-3 py-3 min-w-32 max-w-52 align-bottom ${type === 'text' ? 'text-left' : 'text-right'}`}>{key === 'salary' ? 'Salary (monthly)' : key === 'earned_salary' ? 'Salary (earned)' : label}</th>)}</tr></thead>
          <tbody>{pager.slice.map(row => <tr key={row.id} className="border-t border-neutral-100 dark:border-neutral-850">{visibleColumns.map(({ key, type }) => <td key={key} className={`px-3 py-3 whitespace-nowrap ${type === 'text' ? 'text-left' : 'text-right tabular-nums'}`}>{format(row.payroll_register?.[key], type)}</td>)}</tr>)}</tbody>
        </table>
      </div>
      {filtered.length === 0 && <p className={HELP}>No employees match this search.</p>}
      <Pagination {...pager} noun="employees" />
    </>}
  </section>}</PayrollSheetFrame>;
}
