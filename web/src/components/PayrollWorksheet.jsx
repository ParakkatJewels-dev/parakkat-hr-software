import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Check, Download, Loader2 } from 'lucide-react';
import { usePermissions } from '../auth/usePermissions';
import { useEmployees } from '../data/employees';
import { useVisibleOrg } from '../data/org';
import { todayIso } from '../data/attendance';
import {
  usePayrollPolicy, usePayrollMonthlyInput, usePayrollWorksheetRun, usePayrollRegister,
  useSavePayrollPolicy, useSavePayrollMonthlyInput,
} from '../data/payrollWorksheet';
import {
  MONTHLY_INPUT_FIELDS, PAYROLL_REGISTER_COLUMNS, monthlyInputDraft, payrollPolicyDraft,
  isCompletePayrollRegister, exportPayrollRegister,
} from '../lib/payrollWorksheet';
import { btnClass } from './ui/Btn';
import Pagination, { usePagination } from './ui/Pagination';
import ListSearch from './ui/ListSearch';

const INPUT = 'w-full text-xs rounded-xl px-3 py-2 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-brand/60 disabled:opacity-60';
const LABEL = 'block text-xs font-medium text-neutral-600 dark:text-neutral-300 space-y-1';
const HELP = 'text-xs text-neutral-500 dark:text-neutral-400';
const TITLE = 'text-sm font-bold text-neutral-800 dark:text-neutral-100';
const EMPTY_ROWS = [];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
function useWorksheetDraft(record, toDraft) {
  const [baseline, setBaseline] = useState(() => JSON.stringify(record ?? null));
  const [draft, setDraft] = useState(() => toDraft(record));
  const [dirty, setDirty] = useState(false);
  const incoming = JSON.stringify(record ?? null);
  useEffect(() => {
    if (!dirty && incoming !== baseline) {
      setDraft(toDraft(record));
      setBaseline(incoming);
    }
  }, [record, toDraft, dirty, incoming, baseline]);
  const reset = () => {
    setDraft(toDraft(record));
    setBaseline(incoming);
    setDirty(false);
  };
  return { draft, dirty, changed: dirty && incoming !== baseline, reset,
    patch: (key, value) => { setDraft(current => ({ ...current, [key]: value })); setDirty(true); },
    saved: () => setDirty(false) };
}

export default function PayrollWorksheet() {
  const { can, canAny } = usePermissions();
  const allowed = canAny('payroll.manage');
  const [params] = useSearchParams();
  const [entityId, setEntityId] = useState(() => uuidPattern.test(params.get('entity') ?? '') ? params.get('entity') : '');
  const [period, setPeriod] = useState(() => monthPattern.test(params.get('period') ?? '') ? params.get('period') : todayIso().slice(0, 7));
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
  return <div className="space-y-4">
    <section className="premium-card space-y-3">
      <div>
        <h3 className={TITLE}>Monthly payroll worksheet</h3>
        <p className={`${HELP} mt-1`}>Review the company policy, complete attendance and salary structures, enter monthly additions and deductions, then calculate and review the register before publishing.</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className={LABEL}><span>Company</span>
          <select className={INPUT} value={entityId} onChange={event => setEntityId(event.target.value)} disabled={org.isLoading || employees.isLoading}>
            <option value="">Choose a company…</option>
            {entities.map(item => <option key={item.id} value={item.id}>{item.code} — {item.name}</option>)}
          </select>
        </label>
        <label className={LABEL}><span>Month</span>
          <input type="month" className={INPUT} value={period} max={todayIso().slice(0, 7)} onChange={event => {
            if (monthPattern.test(event.target.value)) setPeriod(event.target.value);
          }} />
        </label>
      </div>
      <ErrorMessage error={org.error || employees.error} />
      {(org.isLoading || employees.isLoading) && <Loading>Loading companies and employees…</Loading>}
      {entityId && !entity && !org.isLoading && !employees.isLoading && !org.error && !employees.error
        && <p className={HELP}>This company is not available in your payroll scope. Choose a company from the list.</p>}
    </section>
    {entity && !org.error && !employees.error && <CompanyWorksheet key={`${entity.id}:${period}`} entity={entity} period={period}
      employees={managedEmployees.filter(employee => employee.entity_id === entity.id)}
      canManageCompany={can('payroll.manage', { entityId: entity.id })} />}
  </div>;
}

function CompanyWorksheet({ entity, period, employees, canManageCompany }) {
  const policy = usePayrollPolicy(entity.id);
  const run = usePayrollWorksheetRun(entity.id, period);
  const register = usePayrollRegister(run.data?.id, { enabled: run.isSuccess });
  const [employeeId, setEmployeeId] = useState('');
  const employee = employees.find(person => person.id === employeeId);
  const employeeSnapshot = register.data?.find(row => row.employee_id === employeeId)?.payroll_register;
  const monthly = usePayrollMonthlyInput(employee?.id, period);
  const published = run.data?.status === 'Published' || run.data?.status === 'Paid';
  const runReadBlocked = !run.isSuccess || run.isFetching || Boolean(run.error);

  return <>
    <section className="premium-card space-y-3">
      <h3 className={TITLE}>Current company calculation policy</h3>
      {published && <p className={HELP}>This month is published. Its inputs and register are read-only. Select an unpublished month to review policy changes for future calculations.</p>}
      <ErrorMessage error={run.error} />
      {run.isLoading && <Loading>Checking whether this month can be edited…</Loading>}
      <ErrorMessage error={policy.error} />
      {policy.isLoading ? <Loading>Loading saved policy…</Loading> : policy.isSuccess || policy.data !== undefined ?
        <PolicyEditor entityId={entity.id} record={policy.data} disabled={published || runReadBlocked || policy.isFetching || Boolean(policy.error) || !canManageCompany} /> : null}
      {!canManageCompany && <p className={HELP}>Company-wide payroll permission is required to save calculation policy. You can maintain inputs for employees within your scope.</p>}
    </section>

    <section className="premium-card space-y-3">
      <div>
        <h3 className={TITLE}>Employee monthly inputs</h3>
        <p className={`${HELP} mt-1`}>These amounts apply only to {period}. Regular monthly salary comes from Salary Structures.</p>
      </div>
      <label className={LABEL}><span>Employee</span>
        <select value={employeeId} className={INPUT} onChange={event => setEmployeeId(event.target.value)}>
          <option value="">Choose an employee…</option>
          {employees.map(person => <option key={person.id} value={person.id}>{person.full_name} · {person.employee_code}{person.branch?.code ? ` · ${person.branch.code}` : ''}</option>)}
        </select>
      </label>
      {employees.length === 0 && <p className={HELP}>No employees are available in your payroll scope for this company.</p>}
      {employee && <>
        {employeeSnapshot && <p className={HELP}>At the last calculation: {employeeSnapshot.recorded_ot_hours ?? '—'} recorded OT hours and {employeeSnapshot.recorded_late_hours ?? '—'} eligible recorded late hours. Review current attendance before approving changes.</p>}
        <ErrorMessage error={monthly.error} />
        {monthly.isLoading ? <Loading>Loading this employee’s saved inputs…</Loading> : monthly.isSuccess || monthly.data !== undefined ?
          <MonthlyInputEditor key={employeeId} employeeId={employeeId} period={period} record={monthly.data}
            disabled={published || runReadBlocked || monthly.isFetching || Boolean(monthly.error)} /> : null}
      </>}
    </section>
    <Register entity={entity} period={period} runQuery={run} registerQuery={register} canManageCompany={canManageCompany} />
  </>;
}

function DraftConflict({ changed, reset }) {
  return changed ? <div className="space-y-2 text-xs text-amber-700 dark:text-amber-300" role="alert">
    <p>Saved values changed while you were editing. Reload them before saving another change.</p>
    <button type="button" className={btnClass('ghost')} onClick={reset}>Reload saved values</button>
  </div> : null;
}

function PolicyEditor({ entityId, record, disabled }) {
  const editor = useWorksheetDraft(record, payrollPolicyDraft);
  const save = useSavePayrollPolicy();
  const [success, setSuccess] = useState(false);
  const blocked = disabled || save.isPending || editor.changed;
  const patch = (key, value) => { editor.patch(key, value); save.reset(); setSuccess(false); };
  return <form className="space-y-3" onSubmit={async event => {
    event.preventDefault();
    if (blocked) return;
    setSuccess(false);
    try { await save.mutateAsync({ entityId, policy: editor.draft, expectedUpdatedAt: record?.updated_at ?? null }); editor.saved(); setSuccess(true); }
    catch { /* shown below without clearing typed values */ }
  }}>
    {!record && <p className="text-xs text-amber-700 dark:text-amber-300">No reviewed policy has been saved. Calendar days, 8 hours per day and 2× OT are suggestions. Review these values and save your company’s policy before running payroll.</p>}
    <fieldset disabled={blocked} className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <label className={LABEL}><span>Salary divisor</span><select className={INPUT} value={editor.draft.divisor_mode} onChange={event => patch('divisor_mode', event.target.value)}>
          <option value="calendar">Calendar days in the month</option><option value="fixed">Fixed days</option><option value="working">Scheduled working days</option>
        </select></label>
        <label className={LABEL}><span>Fixed days</span><input type="number" className={INPUT} min="1" max="31" step="0.01" disabled={editor.draft.divisor_mode !== 'fixed'} value={editor.draft.fixed_days} onChange={event => patch('fixed_days', event.target.value)} /></label>
        <label className={LABEL}><span>Working hours per day</span><input required type="number" className={INPUT} min="0.01" max="24" step="0.01" value={editor.draft.hours_per_day} onChange={event => patch('hours_per_day', event.target.value)} /></label>
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
      <button className={btnClass('primary')} type="submit" disabled={blocked}>{save.isPending && <Loader2 size={13} className="animate-spin" />}Save reviewed policy</button>
      {success && <p role="status" className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-300"><Check size={13} />Policy saved. Recalculate affected drafts.</p>}
    </div>
  </form>;
}

function MonthlyInputEditor({ employeeId, period, record, disabled }) {
  const editor = useWorksheetDraft(record, monthlyInputDraft);
  const save = useSavePayrollMonthlyInput();
  const [success, setSuccess] = useState(false);
  const blocked = disabled || save.isPending || editor.changed;
  const notesRequired = Number(editor.draft.other_deductions) > 0 || Number(editor.draft.late_hours) > 0 || editor.draft.pf.trim() !== '' || editor.draft.esi.trim() !== '';
  const patch = (key, value) => { editor.patch(key, value); save.reset(); setSuccess(false); };
  return <form className="space-y-4" onSubmit={async event => {
    event.preventDefault();
    if (blocked) return;
    setSuccess(false);
    try { await save.mutateAsync({ employeeId, period, input: editor.draft, expectedUpdatedAt: record?.updated_at ?? null }); editor.saved(); setSuccess(true); }
    catch { /* shown below without clearing typed values */ }
  }}>
    <fieldset disabled={blocked} className="space-y-4">
      {['Earnings', 'Hours', 'Deductions'].map(group => <div key={group} className="space-y-2">
        <h4 className="text-xs font-bold uppercase tracking-wide text-neutral-500">{group}{group !== 'Hours' ? ' (₹)' : ''}</h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
          {MONTHLY_INPUT_FIELDS.filter(field => field.group === group).map(field => <label key={field.key} className={LABEL}>
            <span>{field.label}</span><input className={INPUT} type="number" min="0" step="0.01" max={group === 'Hours' ? 744 : 9999999999.99}
              value={editor.draft[field.key]} onChange={event => patch(field.key, event.target.value)}
              placeholder={field.nullable ? 'Use configured component' : '0.00'} />
          </label>)}
        </div>
        {group === 'Hours' && <p className={HELP}>Enter approved hours after reviewing attendance. Blank means zero. Approved hours cannot exceed recorded hours; late deductions apply only to fully paid working days and require a reason.</p>}
        {group === 'Deductions' && <p className={HELP}>Leave PF and ESI blank to use configured components. Enter 0 to override with zero. Record a reason for any override or loss / damage / other deduction.</p>}
      </div>)}
      <label className={LABEL}><span>Input notes / deduction reason{notesRequired ? ' (required)' : ''}</span>
        <textarea required={notesRequired} className={INPUT} rows={2} value={editor.draft.notes} onChange={event => patch('notes', event.target.value)} placeholder="Approval reference, adjustment reason or monthly payroll notes." />
      </label>
    </fieldset>
    <DraftConflict changed={editor.changed} reset={editor.reset} />
    <ErrorMessage error={save.error} />
    <div className="flex flex-wrap items-center gap-3">
      <button type="submit" disabled={blocked} className={btnClass('primary')}>{save.isPending && <Loader2 size={13} className="animate-spin" />}Save monthly inputs</button>
      {success && <p role="status" className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-300"><Check size={13} />Inputs saved. Recalculate the draft to update salary.</p>}
    </div>
  </form>;
}

function Register({ entity, period, runQuery, registerQuery: register, canManageCompany }) {
  const run = runQuery.data;
  const [search, setSearch] = useState('');
  const [exporting, setExporting] = useState(false);
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
  const blocked = loading || Boolean(readError) || !run || !rows.length || incomplete || countMismatch || stale;
  const format = (value, type) => value == null ? '—' : type === 'text' ? String(value)
    : Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-IN', { minimumFractionDigits: type === 'money' ? 2 : 0, maximumFractionDigits: 2 }) : '—';
  return <section className="premium-card space-y-3 min-w-0">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className={TITLE}>Payroll register{run ? ` · ${run.status}` : ''}</h3>
        <p className={`${HELP} mt-1`}>{period} · {entity.code} · {rows.length} visible employees. Amounts are in rupees.</p></div>
      <button type="button" className={btnClass('ghost')} disabled={blocked || exporting} onClick={async () => {
        if (blocked) return;
        setExportError(null); setExporting(true);
        try { await exportPayrollRegister(rows, entity.code, period); }
        catch (error) { setExportError(error); }
        finally { setExporting(false); }
      }}>{exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}Export Excel</button>
    </div>
    <p className={HELP}>The register follows your 33 spreadsheet columns. The first Salary is the monthly salary; the second is earned salary. Export includes all visible employees, regardless of the search or page.</p>
    {calculationPolicy && !readError && <p className={HELP}>Saved calculation basis: {calculationPolicy.divisor_mode === 'fixed' ? `${calculationPolicy.fixed_days} fixed days` : calculationPolicy.divisor_mode === 'working' ? 'scheduled working days' : 'calendar days'}, {calculationPolicy.hours_per_day} hours per day, {calculationPolicy.ot_multiplier}× OT. Late deduction {calculationPolicy.deduct_late ? 'enabled' : 'disabled'}. Total Working Hours shows recorded worked hours.</p>}
    <ErrorMessage error={readError || exportError} />
    {loading && <Loading>Loading the saved payroll register…</Loading>}
    {stale && <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">Inputs changed after this draft was calculated. Re-run payroll before reviewing, exporting or publishing these amounts.</p>}
    {incomplete && !loading && !readError && <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">This run has missing or incomplete worksheet snapshots. Recalculate a draft to create its register. Published legacy runs retain their existing payslips.</p>}
    {countMismatch && !loading && !readError && <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">The loaded register does not match the run’s employee count. Refresh the run before exporting.</p>}
    {!run && !loading && !readError && <p className={HELP}>No payroll has been calculated for this company and month. Save the policy and monthly inputs, then use Run Payroll to calculate the register.</p>}
    {run && !loading && !readError && rows.length === 0 && <p className={HELP}>No register rows are available within your scope for this run.</p>}
    {rows.length > 0 && !readError && <>
      <ListSearch value={search} onChange={setSearch} label="Search payroll register" placeholder="Search employee or branch…" />
      <div className="overflow-x-auto rounded-xl border border-neutral-200 dark:border-neutral-850" tabIndex={0} aria-label="Payroll register, scroll horizontally for all columns">
        <table className="w-full text-xs text-neutral-700 dark:text-neutral-200">
          <caption className="sr-only">{entity.name} payroll register for {period}{stale ? ', pending recalculation' : ''}</caption>
          <thead className="bg-neutral-50 dark:bg-neutral-900"><tr>{PAYROLL_REGISTER_COLUMNS.map(({ key, label, type }) => <th key={key} scope="col" className={`px-3 py-3 min-w-32 max-w-52 align-bottom ${type === 'text' ? 'text-left' : 'text-right'}`}>{key === 'salary' ? 'Salary (monthly)' : key === 'earned_salary' ? 'Salary (earned)' : label}</th>)}</tr></thead>
          <tbody>{pager.slice.map(row => <tr key={row.id} className="border-t border-neutral-100 dark:border-neutral-850">{PAYROLL_REGISTER_COLUMNS.map(({ key, type }) => <td key={key} className={`px-3 py-3 whitespace-nowrap ${type === 'text' ? 'text-left' : 'text-right tabular-nums'}`}>{format(row.payroll_register?.[key], type)}</td>)}</tr>)}</tbody>
        </table>
      </div>
      {filtered.length === 0 && <p className={HELP}>No employees match this search.</p>}
      <Pagination {...pager} noun="employees" />
    </>}
  </section>;
}
