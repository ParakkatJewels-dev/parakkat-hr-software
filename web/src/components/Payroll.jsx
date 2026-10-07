// Payroll Console.
//
// Salary is calculated by the database (public.run_payroll) from attendance the engine already
// derived — this screen never does money maths, it configures inputs and shows results.
//
// Managers use a single monthly workflow, with history and recurring setup alongside it.
// Employees see only their permitted payslips.
import React, { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { hasAnyPayrollSessionChanges } from '../lib/usePayrollSessionState';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  DollarSign, FileText, Loader2, AlertTriangle, Play, Plus, Trash2, X,
  Settings2, Users, History,
} from 'lucide-react';
import {
  usePayslips, usePayslipLines, usePayComponents, useSavePayComponent,
  useDeletePayComponent,
} from '../data/payroll';
import { useVisibleOrg } from '../data/org';
import { usePermissions } from '../auth/usePermissions';
import { useAuth } from '../auth/AuthContext';
import { useUrlTab } from '../lib/useUrlTab';
import { useSectionCounts } from '../data/sectionCounts';
import { navigationCountLabel, navigationScreenCount } from '../lib/navigationCounts';
import { NavigationCountBadge } from './ui/CountBadge';
import { todayIso } from '../data/attendance';
import { SkeletonRows } from './ui/Skeleton';
import { btnClass } from './ui/Btn';
import Pagination, { usePagination } from './ui/Pagination';
import ListSearch from './ui/ListSearch';
import PayrollWorksheet from './PayrollWorksheet';
import PayrollSalarySetup from './PayrollSalarySetup';
import PayrollHistory from './PayrollHistory';

const money = (n) =>
  n == null
    ? '—'
    : `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const INPUT =
  'w-full text-xs rounded-xl px-3 py-2 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-brand/60';
const BTN = btnClass('primary');
const BTN_GHOST = btnClass('ghost');
const statusClass = (s) =>
  s === 'Paid' || s === 'Published'
    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-400'
    : 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-400';

const Err = ({ e }) =>
  e ? (
    <p className="flex items-start gap-1.5 text-xs text-rose-500 mt-2">
      <AlertTriangle size={12} className="shrink-0 mt-0.5" /> {e.message}
    </p>
  ) : null;

// The legacy worksheet route opens the same monthly workflow so old bookmarks keep working.
const TAB_DEFS = [
  { id: 'run', label: 'Run Payroll', icon: Play, managerOnly: true },
  { id: 'history', label: 'Payroll history', icon: History, managerOnly: true },
  { id: 'payslips', label: 'Payslips', icon: FileText, managerOnly: false },
  { id: 'salary', label: 'Salary setup', icon: Users, managerOnly: true },
  { id: 'components', label: 'Pay components', icon: Settings2, managerOnly: true },
];

export default function Payroll() {
  const { canAny, viewingAsEmployee } = usePermissions();
  const canManage = canAny('payroll.manage');
  const counts = useSectionCounts({ enabled: canManage, selfOnly: viewingAsEmployee });
  const runBadge = canManage ? navigationScreenCount('payroll/run', counts.data) : null;

  const TABS = TAB_DEFS.filter((t) => !t.managerOnly || canManage);
  // In the URL, so a refresh comes back to the tab you were reading. See lib/useUrlTab.
  const [routeTab] = useUrlTab(canManage ? 'run' : 'payslips', [...TABS.map((t) => t.id), ...(canManage ? ['worksheet'] : [])]);
  const tab = routeTab === 'worksheet' ? 'run' : routeTab;
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const setTab = id => {
    const next = new URLSearchParams(params);
    next.delete('step');
    navigate(`/payroll/${id}${next.size ? `?${next}` : ''}`, { replace: true });
  };
  const [worksheetBusy, setWorksheetBusy] = useState(false);
  const client = useQueryClient();
  useEffect(() => {
    const warn = event => {
      if (!hasAnyPayrollSessionChanges(client) && !worksheetBusy) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [client, worksheetBusy]);

  return (
    <div className="page-shell space-y-5 animate-fade-in">
      <div>
        <h1 className="text-xl font-bold text-neutral-900 dark:text-white leading-tight font-sans flex items-center gap-2">
          <DollarSign size={20} className="text-brand-ink" /> Payroll
        </h1>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
          {canManage
            ? 'Run each month in three steps. Keep salary setup and past payroll in one place.'
            : 'Your payslips.'}
        </p>
      </div>

      {TABS.length > 1 && (
        <nav aria-label="Payroll views" className="mobile-segmented mobile-segmented-dense tab-scroll flex border-b border-neutral-200 dark:border-neutral-900 space-x-5 text-xs">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              disabled={worksheetBusy && t.id !== tab}
              aria-current={tab === t.id ? 'page' : undefined}
              aria-label={navigationCountLabel(t.label, t.id === 'run' ? runBadge : null)}
              className={`pb-2.5 shrink-0 whitespace-nowrap flex items-center gap-1.5 font-semibold cursor-pointer border-b-2 transition-all ${
                tab === t.id
                  ? 'border-brand text-brand-ink'
                  : 'border-transparent text-neutral-500 hover:text-neutral-900 dark:hover:text-white'
              }`}
            >
              <t.icon size={13} /> {t.label}
              {t.id === 'run' && <NavigationCountBadge badge={runBadge} />}
            </button>
          ))}
        </nav>
      )}

      {tab === 'payslips' && <PayslipsTab />}
      {tab === 'run' && <PayrollWorksheet onBusyChange={setWorksheetBusy} />}
      {tab === 'history' && <PayrollHistory onBusyChange={setWorksheetBusy} />}
      {tab === 'salary' && <PayrollSalarySetup onBusyChange={setWorksheetBusy} />}
      {tab === 'components' && <ComponentsTab />}

    </div>
  );
}

// ---------------------------------------------------------------- payslips
function PayslipsTab() {
  // "My Payslips" must mean it. Without this the tab shows every payslip RLS returns — for an HR
  // manager that is the whole company, names and net pay, under an ESS heading.
  const { employee } = useAuth();
  const { viewingAsEmployee, canBeyondSelf } = usePermissions();
  const mineOnly = viewingAsEmployee || !canBeyondSelf('payslip.read');
  const [params] = useSearchParams();
  const { data: org } = useVisibleOrg();
  const [companyId, setCompanyId] = useState(() => mineOnly ? '' : params.get('entity') || '');
  const [period, setPeriod] = useState(() => /^\d{4}-(0[1-9]|1[0-2])$/.test(params.get('period') ?? '') ? params.get('period') : todayIso().slice(0, 7));
  const [search, setSearch] = useState('');
  const { data: payslips = [], isLoading, error } = usePayslips(mineOnly ? employee?.id : undefined, {
    period, enabled: !mineOnly || Boolean(employee?.id),
  });
  const [openId, setOpenId] = useState(null);

  // A payroll run produces one payslip per person — 242 rows. Hook sits above the early
  // returns so it runs in the same order on every render.
  const matching = payslips.filter((p) => (!companyId || mineOnly || p.entity_id === companyId) && `${p.employee?.full_name ?? ''} ${p.employee?.employee_code ?? ''} ${p.employee?.branch?.code ?? ''} ${p.status}`.toLowerCase().includes(search.trim().toLowerCase()));
  const pager = usePagination(matching, 25, null, `${period}:${companyId}:${search}:${mineOnly}`);

  return (
    <div className="space-y-2">
      <div className="premium-card flex flex-col sm:flex-row gap-3 sm:items-end">
        {!mineOnly && <label className="text-xs font-semibold text-neutral-500">Company
          <select aria-label="Payslip company" value={companyId} onChange={event => setCompanyId(event.target.value)} className={INPUT + ' block mt-1'}>
            <option value="">All companies</option>{(org?.entities ?? []).map(entity => <option value={entity.id} key={entity.id}>{entity.code} — {entity.name}</option>)}
          </select>
        </label>}
        <label className="text-xs font-semibold text-neutral-500">Payroll month
          <input type="month" required aria-label="Payslip month" value={period} onChange={(e) => { if (e.target.value) setPeriod(e.target.value); }} className={INPUT + ' block mt-1'} />
        </label>
        <div className="flex-1 min-w-0"><ListSearch value={search} onChange={setSearch} label="Search payslips" placeholder="Search employee, code, branch or status…" /></div>
      </div>
      <Err e={error} />
      {isLoading && <SkeletonRows rows={5} />}
      {!isLoading && !error && matching.length === 0 && <p className="premium-card p-8 text-center text-sm text-neutral-500">{search ? 'No matching payslips.' : `No payslips for ${period}. Choose another month to view older payslips.`}</p>}
      {pager.slice.map((p) => (
        <div key={p.id} className="premium-card">
          <button
            onClick={() => setOpenId(openId === p.id ? null : p.id)}
            className="mobile-list-row w-full flex flex-wrap items-center justify-between gap-3 text-left cursor-pointer"
          >
            <div className="min-w-0">
              <span className="block text-sm font-bold text-neutral-900 dark:text-white">{p.period}</span>
              <span className="block text-xs text-neutral-500 mt-0.5 truncate">
                {p.employee?.full_name}
                {p.employee?.employee_code ? ` · ${p.employee.employee_code}` : ''}
                {p.lop_days > 0 ? ` · ${p.lop_days} unpaid day${p.lop_days > 1 ? 's' : ''}` : ''}
              </span>
            </div>
            <div className="mobile-list-actions flex items-center gap-4">
              <div className="text-right">
                <span className="block text-2xs uppercase tracking-wider text-neutral-400 font-bold">Net pay</span>
                <span className="block text-sm font-bold font-mono text-neutral-900 dark:text-white">{money(p.net)}</span>
              </div>
              <span className={`text-2xs font-bold uppercase px-2 py-1 rounded ${statusClass(p.status)}`}>{p.status}</span>
            </div>
          </button>
          {openId === p.id && <PayslipDetail payslip={p} />}
        </div>
      ))}
      <Pagination {...pager} noun="payslips" />
    </div>
  );
}

function PayslipDetail({ payslip }) {
  const { data: lines = [], isLoading, error } = usePayslipLines(payslip.id);
  const earnings = lines.filter((l) => l.kind === 'earning');
  const deductions = lines.filter((l) => l.kind === 'deduction');
  const employer = lines.filter((l) => l.kind === 'employer');

  if (isLoading) return <SkeletonRows rows={3} compact avatar={false} label="Loading breakdown" className="pt-3" />;
  if (error) return <Err e={error} />;

  const Col = ({ title, rows, total, tone }) => (
    <div>
      <p className="text-xs font-bold uppercase tracking-wider text-neutral-400 mb-1.5">{title}</p>
      {rows.length === 0 ? (
        <p className="text-xs text-neutral-400">—</p>
      ) : (
        rows.map((l) => (
          <div key={l.id} className="mobile-list-row flex justify-between text-xs py-0.5">
            <span className="text-neutral-600 dark:text-neutral-300 truncate pr-2">{l.name}</span>
            <span className="font-mono text-neutral-800 dark:text-neutral-100 shrink-0">{money(l.amount)}</span>
          </div>
        ))
      )}
      <div className={`mobile-list-row flex justify-between text-base font-bold pt-1.5 mt-1 border-t border-neutral-200 dark:border-neutral-800 ${tone}`}>
        <span>Total</span>
        <span className="font-mono">{money(total)}</span>
      </div>
    </div>
  );

  return (
    <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-850 space-y-4">
      {payslip.payroll_register && (
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          {[
            ['Monthly salary', money(payslip.payroll_register.salary)],
            ['Earned salary', money(payslip.payroll_register.earned_salary)],
            ['Day rate', money(payslip.payroll_register.per_day_wages)],
            ['Hour rate', money(payslip.payroll_register.per_hour_wages)],
            ['Actual working days', payslip.payroll_register.actual_working_days],
            ['Public holidays', payslip.payroll_register.public_holiday],
            ['Off days', payslip.payroll_register.off_days],
            ['Casual leave', payslip.payroll_register.casual_leave],
            ['Approved OT hours', payslip.payroll_register.ot_hours],
            ['Approved late hours', payslip.payroll_register.late_hours],
          ].map(([label, value]) => <div key={label}><dt className="text-neutral-500">{label}</dt><dd className="mt-1 font-semibold text-neutral-800 dark:text-neutral-100">{value ?? '—'}</dd></div>)}
        </dl>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        <Col title="Earnings" rows={earnings} total={payslip.gross} tone="text-emerald-600 dark:text-emerald-400" />
        <Col title="Deductions" rows={deductions} total={payslip.deductions} tone="text-rose-500" />
      </div>
      <div className="mobile-list-row flex flex-wrap items-center justify-between gap-3 rounded-xl bg-neutral-50 dark:bg-charcoal-900/40 px-3 py-2.5">
        <span className="text-xs text-neutral-500">
          Paid {payslip.paid_days ?? '—'} days{payslip.lop_days > 0 ? ` · ${payslip.lop_days} unpaid` : ''}
        </span>
        <span className="text-sm font-bold text-neutral-900 dark:text-white">Net {money(payslip.net)}</span>
      </div>
      {employer.length > 0 && (
        <p className="text-2xs text-neutral-400">
          Employer contributions (not deducted from you):{' '}
          {employer.map((l) => `${l.name} ${money(l.amount)}`).join(' · ')}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- components
const BLANK = {
  code: '',
  name: '',
  kind: 'deduction',
  calc_type: 'percent_of_basic',
  rate: '',
  amount: '',
  cap_base: '',
  max_amount: '',
  min_gross: '',
  max_gross: '',
  employer_share: false,
  prorate_on_lop: true,
  entity_id: '',
  branch_id: '',
  display_order: 100,
};

function ComponentsTab() {
  // pay_components_write checks the full ancestry, unlike payroll_runs_write which stops at the
  // entity — component permissions also consider the branch scope.
  const { can, isSuperAdmin } = usePermissions();
  const { employee } = useAuth();
  const canManageComponent = (c) => can('payroll.manage', {
    entityId: c.entity_id,
    zoneId: c.zone_id,
    branchId: c.branch_id,
    deptId: c.department_id,
  });
  const { data: components = [] } = usePayComponents();
  const componentPager = usePagination(components, 25);
  const { data: org } = useVisibleOrg();
  const save = useSavePayComponent();

  /**
   * "All companies" produces entity_id = null, which pay_components_write only accepts from a
   * GLOBAL grant (0088) — every hr_manager and entity_admin who left the default alone got a raw
   * RLS error from the tab's primary action. A truly shared component is still a real thing, but
   * it is a super admin's thing: only they see the option, and everyone else starts on their own
   * company instead of on a refusal.
   */
  const defaultEntityId = employee?.entity_id
    ?? ((org?.entities ?? []).length === 1 ? org.entities[0].id : '');
  const del = useDeletePayComponent();
  const [form, setForm] = useState(() => ({ ...BLANK, entity_id: defaultEntityId }));
  const [editingId, setEditingId] = useState(null);

  const num = (v) => (v === '' || v == null ? null : Number(v));

  const submit = async (e) => {
    e.preventDefault();
    try {
      await save.mutateAsync({
        id: editingId ?? undefined,
        code: form.code.trim().toUpperCase(),
        name: form.name.trim(),
        kind: form.kind,
        calc_type: form.calc_type,
        rate: form.calc_type === 'fixed' ? null : num(form.rate),
        amount: form.calc_type === 'fixed' ? num(form.amount) : null,
        cap_base: num(form.cap_base),
        max_amount: num(form.max_amount),
        min_gross: num(form.min_gross),
        max_gross: num(form.max_gross),
        employer_share: form.employer_share,
        prorate_on_lop: form.prorate_on_lop,
        entity_id: form.entity_id || null,
        branch_id: form.branch_id || null,
        display_order: Number(form.display_order) || 100,
      });
      setForm({ ...BLANK, entity_id: defaultEntityId });
      setEditingId(null);
    } catch {
      /* surfaced below */
    }
  };

  const edit = (c) => {
    setEditingId(c.id);
    setForm({
      ...BLANK,
      ...c,
      rate: c.rate ?? '',
      amount: c.amount ?? '',
      cap_base: c.cap_base ?? '',
      max_amount: c.max_amount ?? '',
      min_gross: c.min_gross ?? '',
      max_gross: c.max_gross ?? '',
      entity_id: c.entity_id ?? '',
      branch_id: c.branch_id ?? '',
    });
  };

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="premium-card space-y-3">
        <div className="mobile-list-row flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
            {editingId ? 'Edit component' : 'Add a deduction or allowance'}
          </h3>
          {editingId && (
            <button
              type="button"
              onClick={() => { setEditingId(null); setForm({ ...BLANK, entity_id: defaultEntityId }); }}
              className="text-neutral-400 hover:text-neutral-800 dark:hover:text-white cursor-pointer"
            >
              <X size={15} />
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <input required placeholder="Code (e.g. PF)" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className={INPUT} />
          <input required placeholder="Name (e.g. Provident Fund)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={INPUT} />
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} className={INPUT + ' cursor-pointer'}>
            <option value="deduction">Deduction (reduces pay)</option>
            <option value="earning">Allowance (part of gross)</option>
          </select>
          <select value={form.calc_type} onChange={(e) => setForm({ ...form, calc_type: e.target.value })} className={INPUT + ' cursor-pointer'}>
            <option value="percent_of_basic">% of basic</option>
            <option value="percent_of_gross">% of regular monthly salary</option>
            <option value="fixed">Fixed amount</option>
          </select>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          {form.calc_type === 'fixed' ? (
            <input type="number" step="0.01" placeholder="Amount ₹" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className={INPUT} />
          ) : (
            <input type="number" step="0.0001" placeholder="Rate %" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} className={INPUT} />
          )}
          <input type="number" step="0.01" placeholder="Cap base at ₹" value={form.cap_base} onChange={(e) => setForm({ ...form, cap_base: e.target.value })} className={INPUT} />
          <input type="number" step="0.01" placeholder="Only if gross ≥ ₹" value={form.min_gross} onChange={(e) => setForm({ ...form, min_gross: e.target.value })} className={INPUT} />
          <input type="number" step="0.01" placeholder="Only if gross ≤ ₹" value={form.max_gross} onChange={(e) => setForm({ ...form, max_gross: e.target.value })} className={INPUT} />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <select
            required={!isSuperAdmin}
            value={form.entity_id}
            onChange={(e) => setForm({ ...form, entity_id: e.target.value })}
            className={INPUT + ' cursor-pointer'}
          >
            {isSuperAdmin
              ? <option value="">All companies</option>
              : <option value="" disabled>Company…</option>}
            {(org?.entities ?? []).map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}
          </select>
          <select value={form.branch_id} onChange={(e) => setForm({ ...form, branch_id: e.target.value })} className={INPUT + ' cursor-pointer'}>
            <option value="">All branches</option>
            {(org?.branches ?? []).map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}
          </select>
          <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300 cursor-pointer">
            <input type="checkbox" checked={form.prorate_on_lop} onChange={(e) => setForm({ ...form, prorate_on_lop: e.target.checked })} className="accent-brand" />
            Reduce with unpaid days
          </label>
          <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300 cursor-pointer">
            <input type="checkbox" checked={form.employer_share} onChange={(e) => setForm({ ...form, employer_share: e.target.checked })} className="accent-brand" />
            Employer's share (not deducted)
          </label>
        </div>

        <div className="form-section-actions flex flex-wrap items-center gap-3">
          <button type="submit" disabled={save.isPending} className={BTN}>
            {save.isPending ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}{' '}
            {editingId ? 'Save changes' : 'Add component'}
          </button>
          <span className="text-2xs text-neutral-400">
            Percentage components use regular salary before monthly additions and OT. Review statutory wage bases and coverage for the month; enter approved PF/ESI overrides in the worksheet when needed.
          </span>
        </div>
        <Err e={save.error} />
      </form>

      <section className="premium-card">
        <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-3">
          Applied automatically to every payroll run
        </h3>
        {components.length === 0 ? (
          <p className="py-6 text-center text-xs text-neutral-500">
            Nothing configured yet — payslips will show gross pay with no deductions.
          </p>
        ) : (
          <div className="space-y-1.5">
            {componentPager.slice.map((c) => (
              <div
                key={c.id}
                className="mobile-list-row flex flex-wrap items-center justify-between gap-2 rounded-xl border border-neutral-200/70 dark:border-neutral-850 px-3 py-2"
              >
                <div className="min-w-0">
                  <span className="text-sm font-bold text-neutral-800 dark:text-warm-gray-100">
                    {c.name} <span className="font-mono text-2xs text-neutral-400">{c.code}</span>
                  </span>
                  <span className="block text-2xs text-neutral-500 mt-0.5">
                    {c.kind === 'earning' ? 'Allowance' : c.employer_share ? "Employer's share" : 'Deduction'} ·{' '}
                    {c.calc_type === 'fixed'
                      ? money(c.amount)
                      : `${c.rate}% of ${c.calc_type === 'percent_of_basic' ? 'basic' : 'regular salary'}`}
                    {c.prorate_on_lop ? ' · reduced with unpaid days' : ''}
                    {c.cap_base ? ` · base capped at ${money(c.cap_base)}` : ''}
                    {c.max_gross ? ` · only if gross ≤ ${money(c.max_gross)}` : ''}
                    {c.entity_id || c.branch_id ? ' · scoped' : ''}
                  </span>
                </div>
                <div className="mobile-list-actions flex items-center gap-1.5 shrink-0">
                  {canManageComponent(c) && (
                  <>
                  <button onClick={() => edit(c)} className={BTN_GHOST}>Edit</button>
                  <button
                    onClick={() => del.mutate(c.id)}
                    disabled={del.isPending}
                    className="p-1.5 rounded-lg cursor-pointer text-neutral-400 hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-950/40 disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Delete" aria-label="Delete"
                  >
                    <Trash2 size={13} />
                  </button>
                  </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        <Pagination {...componentPager} noun="pay components" />
        <Err e={del.error} />
      </section>
    </div>
  );
}
