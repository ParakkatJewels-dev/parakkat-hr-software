// Payroll Console.
//
// Salary is calculated by the database (public.run_payroll) from attendance the engine already
// derived — this screen never does money maths, it configures inputs and shows results.
//
// Tabs, gated by permission:
//   Payslips    everyone with payslip.read (an employee sees only their own)
//   Run Payroll payroll.manage — pick company + month, run, review, publish
//   Salary      payroll.manage — effective-dated basic/gross per employee
//   Deductions  payroll.manage — the configurable, scoped component catalogue
import React, { useMemo, useState } from 'react';
import {
  DollarSign, FileText, Loader2, AlertTriangle, Play, Check, Plus, Trash2, X,
  Settings2, Users,
} from 'lucide-react';
import {
  usePayslips, usePayslipLines, usePayrollRuns, useRunPayroll, usePublishPayroll,
  useSalaryStructures, useSaveSalaryStructure, usePayComponents, useSavePayComponent,
  useDeletePayComponent,
} from '../data/payroll';
import { useEmployees } from '../data/employees';
import { useVisibleOrg } from '../data/org';
import { usePermissions } from '../auth/usePermissions';
import { useUrlTab } from '../lib/useUrlTab';
import { todayIso } from '../data/attendance';
import { SkeletonRows } from './ui/Skeleton';
import { btnClass } from './ui/Btn';
import Pagination, { usePagination } from './ui/Pagination';

const money = (n) =>
  n == null
    ? '—'
    : `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const INPUT =
  'w-full text-xs rounded-xl px-3 py-2 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-[#0ea971]/60';
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

/**
 * Every tab this screen can draw, and the ids the URL may carry.
 *
 * One definition, at module scope, because two hand-written lists drifted and took the whole
 * payroll admin with them: the whitelist read ['payslips','runs','structures','reports'] while the
 * tabs were payslips/run/salary/components, so three of the four failed the check in useUrlTab and
 * bounced back to Payslips. No salary could be entered, no component configured and no payroll run
 * — from the app at all. Reports & Analytics had the identical bug.
 *
 * The id list handed to useUrlTab is now the PERMITTED set, not the whole catalogue.
 *
 * It used to be every id, on the reasoning that "a URL is valid or it is not". That is true of a
 * typo and false of a permission: the tab bar hid Run Payroll, Salary Structures and Deductions
 * from anyone without payroll.manage, but the content below switches on `tab` alone — so typing
 * /payroll/run drew the whole payroll console for a user who was never offered it. Validating
 * against what this caller may see means an unpermitted id is simply not a tab they have, and
 * useUrlTab falls back to Payslips exactly as it does for a stale bookmark.
 */
const TAB_DEFS = [
  { id: 'payslips', label: 'Payslips', icon: FileText, managerOnly: false },
  { id: 'run', label: 'Run Payroll', icon: Play, managerOnly: true },
  { id: 'salary', label: 'Salary Structures', icon: Users, managerOnly: true },
  { id: 'components', label: 'Deductions & Allowances', icon: Settings2, managerOnly: true },
];

export default function Payroll() {
  const { canAny } = usePermissions();
  const canManage = canAny('payroll.manage');

  const TABS = TAB_DEFS.filter((t) => !t.managerOnly || canManage);
  // In the URL, so a refresh comes back to the tab you were reading. See lib/useUrlTab.
  const [tab, setTab] = useUrlTab('payslips', TABS.map((t) => t.id));

  return (
    <div className="page-shell space-y-5 animate-fade-in">
      <div>
        <h1 className="text-xl font-bold text-neutral-900 dark:text-white leading-tight font-sans flex items-center gap-2">
          <DollarSign size={20} className="text-[#0ea971]" /> Payroll
        </h1>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
          {canManage
            ? 'Salary is calculated from attendance — loss-of-pay days reduce it automatically.'
            : 'Your payslips.'}
        </p>
      </div>

      {TABS.length > 1 && (
        <div className="mobile-segmented tab-scroll flex border-b border-neutral-200 dark:border-neutral-900 space-x-5 text-xs">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? 'page' : undefined}
              className={`pb-2.5 shrink-0 whitespace-nowrap flex items-center gap-1.5 font-semibold cursor-pointer border-b-2 transition-all ${
                tab === t.id
                  ? 'border-[#0ea971] text-[#0ea971]'
                  : 'border-transparent text-neutral-500 hover:text-neutral-900 dark:hover:text-white'
              }`}
            >
              <t.icon size={13} /> {t.label}
            </button>
          ))}
        </div>
      )}

      {tab === 'payslips' && <PayslipsTab />}
      {tab === 'run' && <RunTab />}
      {tab === 'salary' && <SalaryTab />}
      {tab === 'components' && <ComponentsTab />}
    </div>
  );
}

// ---------------------------------------------------------------- payslips
function PayslipsTab() {
  const { data: payslips = [], isLoading, error } = usePayslips();
  const [openId, setOpenId] = useState(null);

  // A payroll run produces one payslip per person — 242 rows. Hook sits above the early
  // returns so it runs in the same order on every render.
  const pager = usePagination(payslips);

  if (isLoading) {
    return <SkeletonRows rows={5} />;
  }
  if (error) return <div className="premium-card"><Err e={error} /></div>;
  if (payslips.length === 0) {
    return <div className="premium-card p-8 text-center text-xs text-neutral-500">No payslips yet.</div>;
  }

  return (
    <div className="space-y-2">
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
  const { data: lines = [], isLoading } = usePayslipLines(payslip.id);
  const earnings = lines.filter((l) => l.kind === 'earning');
  const deductions = lines.filter((l) => l.kind === 'deduction');
  const employer = lines.filter((l) => l.kind === 'employer');

  if (isLoading) return <p className="pt-3 text-xs text-neutral-400">Loading breakdown…</p>;

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

// ---------------------------------------------------------------- run payroll
function RunTab() {
  const { data: org } = useVisibleOrg();
  const { data: runs = [] } = usePayrollRuns();
  const runPayroll = useRunPayroll();
  const publish = usePublishPayroll();
  const entities = org?.entities ?? [];

  const [entityId, setEntityId] = useState('');
  const [period, setPeriod] = useState(todayIso().slice(0, 7));
  const [result, setResult] = useState(null);

  const go = async () => {
    setResult(null);
    try {
      setResult(await runPayroll.mutateAsync({ entity_id: entityId, period }));
    } catch {
      /* surfaced below */
    }
  };

  return (
    <div className="space-y-4">
      <section className="premium-card space-y-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          Calculate a month
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-neutral-500 mb-1">Company</label>
            <select value={entityId} onChange={(e) => setEntityId(e.target.value)} className={INPUT + ' cursor-pointer'}>
              <option value="">Choose…</option>
              {entities.map((e) => (
                <option key={e.id} value={e.id}>{e.code} — {e.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-neutral-500 mb-1">Month</label>
            <input
              type="month"
              value={period}
              max={todayIso().slice(0, 7)}
              onChange={(e) => e.target.value && setPeriod(e.target.value)}
              className={INPUT}
            />
          </div>
          <div className="flex items-end">
            <button onClick={go} disabled={!entityId || runPayroll.isPending} className={BTN + ' w-full justify-center'}>
              {runPayroll.isPending ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Run payroll
            </button>
          </div>
        </div>
        <p className="text-2xs text-neutral-400">
          Re-running a draft month recalculates it from scratch. Unpaid days come from attendance, so
          finish attendance corrections first.
        </p>
        <Err e={runPayroll.error} />
        {result && (
          <div className="flex items-start gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3">
            <Check size={14} className="text-emerald-500 shrink-0 mt-0.5" />
            <p className="text-xs text-emerald-700 dark:text-emerald-300">
              {result.period}: {result.employees} employees · gross {money(result.total_gross)} · net{' '}
              {money(result.total_net)}. Review the payslips, then publish to make them visible to staff.
            </p>
          </div>
        )}
      </section>

      <section className="premium-card">
        <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-3">
          Previous runs
        </h3>
        {runs.length === 0 ? (
          <p className="py-6 text-center text-xs text-neutral-500">No payroll has been run yet.</p>
        ) : (
          <div className="space-y-2">
            {runs.map((r) => (
              <div
                key={r.id}
                className="mobile-list-row flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-200/70 dark:border-neutral-850 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <span className="block text-xs font-bold text-neutral-800 dark:text-warm-gray-100">
                    {r.period} · {r.entity?.code}
                  </span>
                  <span className="block text-2xs text-neutral-500 mt-0.5">
                    {r.employees} employees · net {money(r.total_net)}
                  </span>
                </div>
                <div className="mobile-list-actions flex items-center gap-2">
                  <span className={`text-2xs font-bold uppercase px-2 py-1 rounded ${statusClass(r.status)}`}>
                    {r.status}
                  </span>
                  {r.status === 'Draft' && (
                    <button onClick={() => publish.mutate(r.id)} disabled={publish.isPending} className={BTN}>
                      {publish.isPending ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />} Publish
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        <Err e={publish.error} />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- salary structures
function SalaryTab() {
  const { data: employees = [] } = useEmployees();
  const { data: structures = [] } = useSalaryStructures();
  const save = useSaveSalaryStructure();
  const [form, setForm] = useState({
    employee_id: '',
    effective_from: `${todayIso().slice(0, 7)}-01`,
    basic: '',
    gross: '',
  });

  // The newest row per employee is the one payroll will use.
  const latest = useMemo(() => {
    const m = new Map();
    for (const s of structures) if (!m.has(s.employee_id)) m.set(s.employee_id, s);
    return m;
  }, [structures]);

  const submit = async (e) => {
    e.preventDefault();
    try {
      await save.mutateAsync({
        employee_id: form.employee_id,
        effective_from: form.effective_from,
        basic: Number(form.basic),
        gross: Number(form.gross),
      });
      setForm({ ...form, employee_id: '', basic: '', gross: '' });
    } catch {
      /* surfaced below */
    }
  };

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="premium-card space-y-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">Set salary</h3>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <select
            required
            value={form.employee_id}
            onChange={(e) => setForm({ ...form, employee_id: e.target.value })}
            className={INPUT + ' cursor-pointer'}
          >
            <option value="">Employee…</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.full_name} {e.employee_code ? `(${e.employee_code})` : ''}
              </option>
            ))}
          </select>
          <input
            type="date"
            required
            value={form.effective_from}
            onChange={(e) => setForm({ ...form, effective_from: e.target.value })}
            className={INPUT}
            title="Effective from" aria-label="Effective from"
          />
          <input
            type="number"
            required
            min="0"
            step="0.01"
            placeholder="Basic"
            value={form.basic}
            onChange={(e) => setForm({ ...form, basic: e.target.value })}
            className={INPUT}
          />
          <input
            type="number"
            required
            min="0"
            step="0.01"
            placeholder="Monthly gross"
            value={form.gross}
            onChange={(e) => setForm({ ...form, gross: e.target.value })}
            className={INPUT}
          />
        </div>
        <div className="form-section-actions flex flex-wrap items-center gap-3">
          <button type="submit" disabled={save.isPending} className={BTN}>
            {save.isPending ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} Save salary
          </button>
          <span className="text-2xs text-neutral-400">
            Effective-dated: a raise is a new row, so history is preserved. Basic must not exceed gross.
          </span>
        </div>
        <Err e={save.error} />
      </form>

      <section className="premium-card">
        <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-3">
          Current salaries ({latest.size} of {employees.length} employees)
        </h3>
        {latest.size === 0 ? (
          <p className="py-6 text-center text-xs text-neutral-500">
            No salaries set. Employees without a salary structure are skipped by payroll.
          </p>
        ) : (
          <div className="table-scroll">
            <table className="premium-table w-full text-left">
              <thead>
                <tr className="text-xs font-bold uppercase tracking-wider text-neutral-450 border-b border-neutral-200/70 dark:border-neutral-850">
                  <th className="py-1.5 pr-2">Employee</th>
                  <th className="py-1.5 px-2">Effective</th>
                  <th className="py-1.5 px-2 text-right">Basic</th>
                  <th className="py-1.5 pl-2 text-right">Gross</th>
                </tr>
              </thead>
              <tbody>
                {[...latest.values()].map((s) => (
                  <tr key={s.id} className="border-b border-neutral-100 dark:border-neutral-900/60 last:border-0 text-xs">
                    <td data-label="Employee" className="py-1.5 pr-2 font-bold text-neutral-800 dark:text-warm-gray-100">
                      {s.employee?.full_name}{' '}
                      <span className="font-mono text-2xs text-neutral-400">{s.employee?.employee_code}</span>
                    </td>
                    <td data-label="Effective" className="py-1.5 px-2 font-mono text-neutral-500">{s.effective_from}</td>
                    <td data-label="Basic" className="py-1.5 px-2 text-right font-mono">{money(s.basic)}</td>
                    <td data-label="Gross" className="py-1.5 pl-2 text-right font-mono font-bold">{money(s.gross)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
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
  const { data: components = [] } = usePayComponents();
  const { data: org } = useVisibleOrg();
  const save = useSavePayComponent();
  const del = useDeletePayComponent();
  const [form, setForm] = useState(BLANK);
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
      setForm(BLANK);
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
              onClick={() => { setEditingId(null); setForm(BLANK); }}
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
            <option value="percent_of_gross">% of gross</option>
            <option value="fixed">Fixed amount</option>
          </select>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          {form.calc_type === 'fixed' ? (
            <input type="number" step="0.01" placeholder="Amount ₹" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className={INPUT} />
          ) : (
            <input type="number" step="0.0001" placeholder="Rate %" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} className={INPUT} />
          )}
          <input type="number" step="0.01" placeholder="Cap base at ₹ (PF: 15000)" value={form.cap_base} onChange={(e) => setForm({ ...form, cap_base: e.target.value })} className={INPUT} />
          <input type="number" step="0.01" placeholder="Only if gross ≥ ₹" value={form.min_gross} onChange={(e) => setForm({ ...form, min_gross: e.target.value })} className={INPUT} />
          <input type="number" step="0.01" placeholder="Only if gross ≤ ₹ (ESI: 21000)" value={form.max_gross} onChange={(e) => setForm({ ...form, max_gross: e.target.value })} className={INPUT} />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <select value={form.entity_id} onChange={(e) => setForm({ ...form, entity_id: e.target.value })} className={INPUT + ' cursor-pointer'}>
            <option value="">All companies</option>
            {(org?.entities ?? []).map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}
          </select>
          <select value={form.branch_id} onChange={(e) => setForm({ ...form, branch_id: e.target.value })} className={INPUT + ' cursor-pointer'}>
            <option value="">All branches</option>
            {(org?.branches ?? []).map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}
          </select>
          <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300 cursor-pointer">
            <input type="checkbox" checked={form.prorate_on_lop} onChange={(e) => setForm({ ...form, prorate_on_lop: e.target.checked })} className="accent-[#0ea971]" />
            Reduce with unpaid days
          </label>
          <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300 cursor-pointer">
            <input type="checkbox" checked={form.employer_share} onChange={(e) => setForm({ ...form, employer_share: e.target.checked })} className="accent-[#0ea971]" />
            Employer's share (not deducted)
          </label>
        </div>

        <div className="form-section-actions flex flex-wrap items-center gap-3">
          <button type="submit" disabled={save.isPending} className={BTN}>
            {save.isPending ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}{' '}
            {editingId ? 'Save changes' : 'Add component'}
          </button>
          <span className="text-2xs text-neutral-400">
            PF and ESI are normally calculated on earned wages — keep "reduce with unpaid days" ticked.
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
            {components.map((c) => (
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
                      : `${c.rate}% of ${c.calc_type === 'percent_of_basic' ? 'basic' : 'gross'}`}
                    {c.cap_base ? ` · base capped at ${money(c.cap_base)}` : ''}
                    {c.max_gross ? ` · only if gross ≤ ${money(c.max_gross)}` : ''}
                    {c.entity_id || c.branch_id ? ' · scoped' : ''}
                  </span>
                </div>
                <div className="mobile-list-actions flex items-center gap-1.5 shrink-0">
                  <button onClick={() => edit(c)} className={BTN_GHOST}>Edit</button>
                  <button
                    onClick={() => del.mutate(c.id)}
                    disabled={del.isPending}
                    className="p-1.5 rounded-lg cursor-pointer text-neutral-400 hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-950/40 disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Delete" aria-label="Delete"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <Err e={del.error} />
      </section>
    </div>
  );
}
