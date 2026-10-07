import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, ChevronRight, Plus, Users, X } from 'lucide-react';
import { useEmployees } from '../data/employees';
import { useSalaryStructures, useSaveSalaryStructure } from '../data/payroll';
import { useVisibleOrg } from '../data/org';
import { todayIso } from '../data/attendance';
import { usePermissions } from '../auth/usePermissions';
import { usePayrollSessionState } from '../lib/usePayrollSessionState';
import {
  blankGrossComponent, parseMoneyDraft, totalGrossComponentsDraft, totalGrossFromParts,
} from '../lib/salaryDraft';
import { currentSalaryMap, filterSalaryEmployees, salarySetupDraft, salarySetupPayload } from '../lib/payrollSalarySetup';
import { btnClass } from './ui/Btn';
import FormSection, { FIELD, Field, FormError } from './ui/FormSection';
import ConfirmDialog from './ui/ConfirmDialog';
import ListSearch from './ui/ListSearch';
import Pagination, { usePagination } from './ui/Pagination';
import { SkeletonRows } from './ui/Skeleton';

const money = value => value == null ? '—' : `₹${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const SALARY_SESSION_KEY = ['salary-setup'];
const EMPTY_ROWS = [];
const employeeScope = person => ({
  entityId: person.entity_id, zoneId: person.zone_id, branchId: person.branch_id,
  deptId: person.department_id,
  // Salary writes deliberately check ancestry, not an employee/self grant (salary_write RLS).
  employeeId: null,
});

export default function PayrollSalarySetup({ onBusyChange }) {
  const { can, canAny } = usePermissions();
  const allowed = canAny('payroll.manage');
  const employeesQuery = useEmployees({ enabled: allowed });
  const salaryQuery = useSalaryStructures(undefined, { enabled: allowed });
  const { data: org } = useVisibleOrg();
  const save = useSaveSalaryStructure();
  const [params] = useSearchParams();
  const payrollPeriod = params.get('period');
  const defaultEffectiveFrom = `${/^\d{4}-(0[1-9]|1[0-2])$/.test(payrollPeriod || '') ? payrollPeriod : todayIso().slice(0, 7)}-01`;
  const [company, setCompany] = useState(() => params.get('entity') || '');
  const [branch, setBranch] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [draft, setDraft] = usePayrollSessionState(SALARY_SESSION_KEY, null);
  const [pendingSelection, setPendingSelection] = useState(null);
  const [success, setSuccess] = useState('');
  const [formError, setFormError] = useState(null);
  const employees = (employeesQuery.data || []).filter(person => can('payroll.manage', employeeScope(person)));
  const structures = salaryQuery.data || EMPTY_ROWS;
  const today = todayIso();
  const current = useMemo(() => currentSalaryMap(structures, today), [structures, today]);
  const scopedEmployees = filterSalaryEmployees(employees, current, { company, branch });
  const matching = filterSalaryEmployees(employees, current, { company, branch, status, search });
  const pager = usePagination(matching, 25, null, `${company}:${branch}:${status}:${search}`);
  const selected = employees.find(person => person.id === draft?.employeeId);
  const dirty = Boolean(draft && JSON.stringify(draft.form) !== JSON.stringify(draft.initialForm));
  const history = structures.filter(row => row.employee_id === selected?.id)
    .sort((a, b) => (b.effective_from || '').localeCompare(a.effective_from || ''));
  const historyPager = usePagination(history, 5, null, selected?.id || '');
  const companyIds = new Set(employees.map(person => person.entity_id));
  const branchIds = new Set(employees.filter(person => !company || person.entity_id === company).map(person => person.branch_id));
  const companies = (org?.entities || []).filter(entity => companyIds.has(entity.id));
  const branches = (org?.branches || []).filter(item => branchIds.has(item.id));
  const loading = employeesQuery.isLoading || salaryQuery.isLoading;
  const readError = employeesQuery.error || salaryQuery.error;
  const ready = scopedEmployees.filter(person => current.has(person.id)).length;

  useEffect(() => {
    onBusyChange?.(save.isPending);
    return () => onBusyChange?.(false);
  }, [onBusyChange, save.isPending]);

  useEffect(() => {
    if (!dirty && !save.isPending) return undefined;
    const preventClose = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', preventClose);
    return () => window.removeEventListener('beforeunload', preventClose);
  }, [dirty, save.isPending]);

  const replaceDraft = next => {
    setDraft(next);
    setFormError(null);
    setSuccess('');
    save.reset();
  };
  const selectDraft = next => {
    if (save.isPending) return;
    if (dirty) setPendingSelection({ next });
    else replaceDraft(next);
  };
  const editPerson = person => selectDraft(salarySetupDraft(person, current.get(person.id) || structures.find(row => row.employee_id === person.id), defaultEffectiveFrom));
  const patchForm = patch => {
    setFormError(null);
    setDraft(value => ({ ...value, form: { ...value.form, ...patch } }));
  };
  const patchComponent = (index, patch) => patchForm({
    gross_components: draft.form.gross_components.map((item, i) => i === index ? { ...item, ...patch } : item),
  });
  const submit = async () => {
    if (!selected || readError || save.isPending) return;
    setFormError(null);
    save.reset();
    let payload;
    try { payload = salarySetupPayload(draft.form, structures); }
    catch (error) { setFormError(error); return; }
    try {
      await save.mutateAsync(payload);
      setSuccess(`Salary saved for ${selected.full_name}, effective ${payload.effective_from}.`);
      setDraft(null);
    } catch { /* The mutation error remains next to the form. */ }
  };

  if (!allowed) return null;

  return <div className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-base font-bold text-neutral-900 dark:text-white">Salary setup</h2>
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">Find an employee, set their monthly salary, and keep changes by effective date.</p>
      </div>
      {!loading && !readError && <p className="text-xs text-neutral-500 dark:text-neutral-400">
        <span className="font-semibold text-neutral-800 dark:text-neutral-200">{ready} salary set</span>
        <span className="mx-2" aria-hidden="true">·</span>
        <span className={ready < scopedEmployees.length ? 'font-semibold text-amber-700 dark:text-amber-400' : ''}>{scopedEmployees.length - ready} missing salary</span>
      </p>}
    </div>

    {success && <p role="status" className="flex items-center gap-2 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 px-4 py-3 text-xs text-emerald-800 dark:text-emerald-300"><Check size={15} />{success}</p>}

    {draft && !selected && !employeesQuery.isLoading && !employeesQuery.error && <div className="premium-card flex flex-wrap items-center justify-between gap-3">
      <p className="text-xs text-neutral-500">The employee for your saved draft is no longer available in this payroll scope.</p>
      <button type="button" onClick={() => selectDraft(null)} className={btnClass('ghost', 'sm')}>Discard salary draft</button>
    </div>}

    {selected && draft && <FormSection key={selected.id} title={`Salary · ${selected.full_name}`}
      subtitle={[selected.employee_code, selected.branch?.name || selected.branch?.code].filter(Boolean).join(' · ')}
      icon={Users} onSubmit={submit} onClose={() => selectDraft(null)} busy={save.isPending}
      disabled={Boolean(readError) || loading} submitLabel="Save salary" error={formError || save.error}
      footer={<span className="text-xs text-neutral-500">{dirty ? 'Unsaved changes' : 'Gross = basic + gross components'}</span>}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Effective from" htmlFor="salary-effective" required>
          <input id="salary-effective" type="date" required value={draft.form.effective_from}
            onChange={event => patchForm({ effective_from: event.target.value })} className={FIELD} />
        </Field>
        <Field label="Monthly basic (₹)" htmlFor="salary-basic" required>
          <input id="salary-basic" type="number" required min="0" step="0.01" inputMode="decimal"
            value={draft.form.basic} onChange={event => patchForm({ basic: event.target.value })} className={FIELD + ' font-mono'} placeholder="0.00" />
        </Field>
        <Field label="Monthly gross (₹)" htmlFor="salary-gross" hint="Calculated">
          <input id="salary-gross" type="text" readOnly value={totalGrossFromParts(draft.form.basic, draft.form.gross_components)}
            className={FIELD + ' font-mono bg-neutral-100 dark:bg-neutral-950'} placeholder="0.00" />
        </Field>
      </div>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {history.some(row => row.effective_from === draft.form.effective_from)
          ? 'Saving updates the salary for this date. For a raise, choose a new effective date to keep the previous salary.'
          : 'Saving adds a new effective date. Previous salary records stay in the history.'}
      </p>
      <div className="rounded-xl border border-neutral-200 dark:border-neutral-850 p-3 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div><h3 className="text-xs font-bold text-neutral-800 dark:text-neutral-200">Gross components</h3>
            <p className="mt-0.5 text-xs text-neutral-500">Add recurring parts of monthly salary, such as HRA.</p></div>
          <button type="button" onClick={() => patchForm({ gross_components: [...draft.form.gross_components, blankGrossComponent()] })} className={btnClass('ghost', 'sm')}><Plus size={13} /> Add component</button>
        </div>
        {draft.form.gross_components.map((component, index) => <div key={index} className="grid grid-cols-[minmax(0,1fr)_2rem] sm:grid-cols-[minmax(0,1fr)_11rem_2rem] items-end gap-2">
          <Field label="Component name" htmlFor={`salary-component-${index}-name`} className="col-span-2 sm:col-span-1 min-w-0">
            <input id={`salary-component-${index}-name`} aria-label={`Gross component ${index + 1} name`} value={component.name}
              onChange={event => patchComponent(index, { name: event.target.value })} className={FIELD} placeholder="e.g. HRA" />
          </Field>
          <Field label="Monthly amount (₹)" htmlFor={`salary-component-${index}-amount`} className="min-w-0">
            <input id={`salary-component-${index}-amount`} aria-label={`Gross component ${index + 1} amount`} type="number" min="0" step="0.01" inputMode="decimal"
              value={component.amount} onChange={event => patchComponent(index, { amount: event.target.value })} className={FIELD + ' font-mono'} placeholder="0.00" />
          </Field>
          <button type="button" aria-label={`Remove gross component ${index + 1}`} className="mb-0.5 rounded-lg p-2 text-neutral-500 hover:text-rose-600 focus-visible:outline-brand"
            onClick={() => { const next = draft.form.gross_components.filter((_, i) => i !== index); patchForm({ gross_components: next.length ? next : [blankGrossComponent()] }); }}><X size={16} /></button>
        </div>)}
        <p className="flex justify-between border-t border-neutral-200 dark:border-neutral-850 pt-2 text-xs text-neutral-500">Components total <strong className="font-mono text-neutral-800 dark:text-neutral-200">{money(parseMoneyDraft(totalGrossComponentsDraft(draft.form.gross_components)))}</strong></p>
      </div>
      {history.length > 0 && <details className="rounded-xl border border-neutral-200 dark:border-neutral-850 px-3 py-2">
        <summary className="cursor-pointer text-xs font-semibold text-neutral-600 dark:text-neutral-300">Salary history ({history.length})</summary>
        <div className="mt-2 divide-y divide-neutral-100 dark:divide-neutral-850">
          {historyPager.slice.map(salary => <div key={salary.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
            <div><span className="font-mono">{salary.effective_from}</span><span className="ml-2 text-neutral-500">{salary.effective_from > todayIso() ? 'Scheduled' : salary.id === current.get(selected.id)?.id ? 'Current' : 'Previous'}</span>
              <p className="mt-1 text-neutral-500">Basic {money(salary.basic)} · Gross {money(salary.gross)}</p></div>
            <button type="button" onClick={() => selectDraft(salarySetupDraft(selected, salary))} className={btnClass('ghost', 'sm')} aria-label={`Edit salary effective ${salary.effective_from}`}>Edit</button>
          </div>)}
        </div>
        <Pagination {...historyPager} noun="salary records" />
      </details>}
    </FormSection>}

    <section className="premium-card space-y-3" aria-label="Employee salary directory">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <ListSearch value={search} onChange={setSearch} label="Search salary employees" placeholder="Search employee name or code…" />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <label className="sr-only" htmlFor="salary-company">Company</label>
          <select id="salary-company" value={company} onChange={event => { setCompany(event.target.value); setBranch(''); }} className={FIELD}>
            <option value="">All companies</option>
            {company && !companies.some(item => item.id === company) && <option value={company}>Selected company</option>}
            {companies.map(entity => <option key={entity.id} value={entity.id}>{entity.name || entity.code}</option>)}
          </select>
          <label className="sr-only" htmlFor="salary-branch">Branch</label>
          <select id="salary-branch" value={branch} onChange={event => setBranch(event.target.value)} className={FIELD}>
            <option value="">All branches</option>
            {branches.map(item => <option key={item.id} value={item.id}>{item.name || item.code}</option>)}
          </select>
          <label className="sr-only" htmlFor="salary-status">Salary status</label>
          <select id="salary-status" value={status} onChange={event => setStatus(event.target.value)} className={FIELD}>
            <option value="">All salary statuses</option><option value="missing">Missing salary</option><option value="ready">Salary set</option>
          </select>
        </div>
      </div>
      <FormError message={readError} />
      {loading ? <SkeletonRows rows={5} /> : !readError && <>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{matching.length} employee{matching.length === 1 ? '' : 's'} · Salary status is based on today. Select a name to set or update salary.</p>
        {matching.length === 0 ? <div className="py-10 text-center text-sm text-neutral-500">
          {employees.length ? 'No employees match these filters.' : 'No employees are available in your payroll scope.'}
        </div> : <div className="table-scroll">
          <table className="premium-table w-full text-left">
            <thead><tr><th>Employee</th><th>Company / branch</th><th>Monthly basic</th><th>Monthly gross</th><th>Salary status</th></tr></thead>
            <tbody>{pager.slice.map(person => {
              const salary = current.get(person.id);
              const upcoming = !salary && structures.some(row => row.employee_id === person.id && row.effective_from > todayIso());
              return <tr key={person.id} className={selected?.id === person.id ? 'bg-brand/5' : ''}>
                <td data-label="Employee"><button type="button" onClick={() => editPerson(person)} disabled={save.isPending}
                  aria-label={`Set salary for ${person.full_name}${person.employee_code ? ` (${person.employee_code})` : ''}`}
                  className="flex w-full items-center justify-between gap-3 text-left text-brand-ink disabled:opacity-50">
                  <span><span className="block font-semibold">{person.full_name}</span><span className="block mt-0.5 text-xs font-mono text-neutral-500">{person.employee_code || 'No employee code'}{person.status && person.status !== 'Active' ? ` · ${person.status}` : ''}</span></span><ChevronRight size={14} className="shrink-0" />
                </button></td>
                <td data-label="Company / branch"><span className="block">{person.entity?.code || person.entity?.name || companies.find(item => item.id === person.entity_id)?.code || '—'}</span><span className="block mt-0.5 text-xs text-neutral-500">{person.branch?.name || person.branch?.code || 'No branch'}</span></td>
                <td data-label="Monthly basic" className="font-mono">{money(salary?.basic)}</td>
                <td data-label="Monthly gross" className="font-mono font-semibold">{money(salary?.gross)}</td>
                <td data-label="Salary status"><span className={`inline-block rounded-full px-2 py-1 text-xs font-semibold ${salary ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300' : 'bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300'}`}>{salary ? 'Salary set' : 'Missing salary'}</span>
                  <span className="block mt-1 text-xs text-neutral-500">{salary ? `From ${salary.effective_from}` : upcoming ? 'Future salary scheduled' : 'Set before running payroll'}</span></td>
              </tr>;
            })}</tbody>
          </table>
        </div>}
        <Pagination {...pager} noun="employees" />
      </>}
    </section>

    {pendingSelection && <ConfirmDialog title="Discard salary changes?" confirmLabel="Discard changes" cancelLabel="Keep editing"
      onCancel={() => setPendingSelection(null)} onConfirm={() => { replaceDraft(pendingSelection.next); setPendingSelection(null); }}>
      <p>The changes for {selected?.full_name || 'this employee'} have not been saved.</p>
    </ConfirmDialog>}
  </div>;
}
