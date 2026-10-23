import { SkeletonCards, SkeletonRows } from './ui/Skeleton';
import React, { useState, useMemo, useCallback } from 'react';
import { FileText, Check, Ban, Plus, ReceiptText, Clock, CheckCircle2, Car, Plane, Smartphone, HeartPulse, Package } from 'lucide-react';
import { useExpenses, useAddExpense, useSetExpenseStatus } from '../data/expenses';
import { useAuth } from '../auth/AuthContext';
import FormSection, { Field, FIELD, FormError } from './ui/FormSection';
import QueryError from './ui/QueryError';
import { btnClass } from './ui/Btn';
import Pagination, { usePagination } from './ui/Pagination';
import { useFocusRow } from '../lib/useFocusRow';
import { usePermissions } from '../auth/usePermissions';
import { useMineOnly } from '../lib/useMineOnly';
import { todayIso } from '../data/attendance';
import { useSectionCounts } from '../data/sectionCounts';
import { navigationCountLabel, navigationScreenCount } from '../lib/navigationCounts';
import { NavigationCountBadge } from './ui/CountBadge';
import PageHeader from './ui/PageHeader';
import { StatCard, StatRow } from './ui/StatCard';
import StatusPill from './ui/StatusPill';
import { dayMonth } from '../lib/dates';
import './expense.css';

const CATEGORIES = ['Local Conveyance', 'Travel Expenses', 'Telephone/Mobile Bills', 'Medical Claims', 'Office Supplies', 'Other'];
const blankExpenseForm = () => ({ category: 'Local Conveyance', amount: '', expense_date: todayIso(), description: '' });

const EXPENSE_TONE = { Approved: 'success', Paid: 'success', Rejected: 'danger', Pending: 'warning' };

/** An icon for a claim's category, so a list of claims can be scanned by kind. */
const categoryIcon = (category = '') => {
  const c = category.toLowerCase();
  if (/convey|taxi|auto|fuel/.test(c)) return Car;
  if (/travel|outstation|flight|train/.test(c)) return Plane;
  if (/phone|mobile|broadband|internet/.test(c)) return Smartphone;
  if (/medic|health/.test(c)) return HeartPulse;
  if (/office|supplies|stationery/.test(c)) return Package;
  return ReceiptText;
};

export default function Expense() {
  const expensesQuery = useExpenses();
  const { data: expenses = [], isLoading, error, refetch, isFetching } = expensesQuery;
  const hasData = Array.isArray(expensesQuery.data);
  const { employee } = useAuth();
  const { can, canBeyondSelf, viewingAsEmployee } = usePermissions();
  const { data: sectionCounts } = useSectionCounts({ selfOnly: viewingAsEmployee });
  const reviewBadge = navigationScreenCount('expense', sectionCounts);
  const { user } = useAuth();
  const add = useAddExpense();
  const setStatus = useSetExpenseStatus();

  /**
   * May this viewer decide THIS claim?
   *
   * Mirrors expenses_update, which checks the whole ancestry, plus the two rules the database
   * enforces with a trigger: you cannot decide your own claim, and you cannot decide one you filed.
   * Drawing the buttons from canAny alone put them on every branch's claims, and pressing one there
   * silently did nothing — the update matched no rows and PostgREST called that success.
   */
  const canDecide = useCallback((exp) =>
    can('expense.approve', {
      entityId: exp.entity_id,
      zoneId: exp.zone_id,
      branchId: exp.branch_id,
      deptId: exp.department_id,
      employeeId: exp.employee_id,
    })
    && exp.employee_id !== employee?.id
    && !(exp.created_by && exp.created_by === user?.id), [can, employee?.id, user?.id]);
  const canClaim = Boolean(employee?.id);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(blankExpenseForm);
  const [statusFilter, setStatusFilter] = useState('All');
  // A manager's list is their whole branch; this is how they find their own claims in it.
  const [mineOnly, setMineOnly, canPickWhose] = useMineOnly(canBeyondSelf('expense.read'));
  const canReviewQueue = !viewingAsEmployee && canPickWhose && canBeyondSelf('expense.approve');

  const visibleExpenses = useMemo(() => {
    const scoped = mineOnly ? expenses.filter((e) => e.employee_id === employee?.id) : expenses;
    if (statusFilter === 'All') return scoped;
    if (statusFilter === 'My review queue') return scoped.filter((e) => e.status === 'Pending' && canDecide(e));
    if (statusFilter === 'Approved') return scoped.filter((e) => e.status === 'Approved' || e.status === 'Paid');
    return scoped.filter((e) => e.status === statusFilter);
  }, [expenses, statusFilter, mineOnly, employee?.id, canDecide]);

  // How many claims each filter pill holds, from the same Mine / Everyone scope as the list.
  const counts = useMemo(() => {
    const scoped = mineOnly ? expenses.filter((e) => e.employee_id === employee?.id) : expenses;
    return {
      all: scoped.length,
      pending: scoped.filter((e) => e.status === 'Pending').length,
      approved: scoped.filter((e) => e.status === 'Approved' || e.status === 'Paid').length,
      rejected: scoped.filter((e) => e.status === 'Rejected').length,
    };
  }, [expenses, mineOnly, employee?.id]);

  const totals = useMemo(() => {
    // Over the visible rows, not the whole scope — see the same fix in Leave.
    const sum = (pred) => visibleExpenses.filter(pred).reduce((a, e) => a + Number(e.amount || 0), 0);
    return {
      pending: sum((e) => e.status === 'Pending'),
      approved: sum((e) => e.status === 'Approved' || e.status === 'Paid'),
      count: visibleExpenses.length,
    };
  }, [visibleExpenses]);

  const submit = async (e) => {
    e.preventDefault();
    if (add.isPending || !form.amount || !form.expense_date || !form.description || !employee?.id) return;
    try {
      await add.mutateAsync({
        employee_id: employee.id,
        category: form.category,
        amount: parseFloat(form.amount),
        expense_date: form.expense_date,
        description: form.description,
      });
      setForm(blankExpenseForm());
      setShowForm(false);
    } catch { /* shown below */ }
  };


  // Paged: this list grows with the business and was rendering every row.
  const { focusId, rowProps } = useFocusRow();
  const pager = usePagination(visibleExpenses, 25, focusId, `${statusFilter}:${mineOnly}`);

  return (
    <div className={`page-shell space-y-6 animate-fade-in expense-page ${canPickWhose ? '' : 'is-self'}`}>
      {showForm && canClaim && (
        <FormSection
          title="Claim reimbursement"
          subtitle="Filed against your own record; your manager approves it."
          icon={Plus}
          onSubmit={submit}
          submitLabel="Submit claim"
          busy={add.isPending}
          error={add.error}
          onClose={() => { add.reset(); setForm(blankExpenseForm()); setShowForm(false); }}
        >
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Category" htmlFor="exp-category" required>
              <select
                id="exp-category"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                className={FIELD + ' cursor-pointer'}
              >
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Amount" htmlFor="exp-amount" hint="₹" required>
              <input
                id="exp-amount"
                type="number"
                inputMode="decimal"
                required
                min="0"
                step="0.01"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
                className={FIELD}
              />
            </Field>
            <Field label="Date of expense" htmlFor="exp-date" required>
              <input
                id="exp-date"
                type="date"
                required
                value={form.expense_date}
                onChange={(e) => setForm({ ...form, expense_date: e.target.value })}
                className={FIELD}
              />
            </Field>
          </div>
          <Field label="What was it for" htmlFor="exp-desc" required>
            <textarea
              id="exp-desc"
              required
              rows={2}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className={FIELD + ' resize-none'}
              placeholder="e.g. Taxi from Edappally branch to head office"
            />
          </Field>
        </FormSection>
      )}

      <PageHeader title={canPickWhose ? 'Expense Management' : 'My expenses'}
        subtitle={canPickWhose ? 'Claims, approvals and reimbursements in one place.' : 'Claim what you spent for work and follow each claim.'}>
        <div className="flex items-center gap-2">
          {/* A manager's list is their whole branch. Without this there is no way to answer "what
              did I claim?" — which is a question they have too, since 0080 gave every manager role
              expense.create so they could file their own. */}
          {canPickWhose && canClaim && (
            <div className="inline-flex rounded-xl border border-neutral-200 dark:border-neutral-800 p-0.5" role="group" aria-label="Whose claims">
              {[['Mine', true], ['Everyone', false]].map(([label, v]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => { setMineOnly(v); if (v && statusFilter === 'My review queue') setStatusFilter('All'); }}
                  aria-pressed={mineOnly === v}
                  className={`px-2.5 py-1 text-2xs font-bold rounded-lg transition-colors cursor-pointer ${
                    mineOnly === v
                      ? 'bg-brand-action text-brand-on'
                      : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {canClaim && !showForm && (
            <button onClick={() => setShowForm(true)} className={btnClass('primary')}>
              Submit Claim
            </button>
          )}
        </div>
      </PageHeader>

      {/* A refused decision has to say so. The database rejects two of these outright — your own
          claim, and one you filed — and both used to arrive as a thrown error nothing rendered, so
          the row simply stayed Pending and the screen looked broken rather than principled. */}
      <FormError message={setStatus.isError ? setStatus.error || 'That decision could not be saved.' : null} />
      <QueryError error={error} title={hasData ? 'Expense claims could not be refreshed.' : 'Expense claims could not be loaded.'}
        onRetry={refetch} retrying={isFetching} hasData={hasData} />

      {isLoading ? <SkeletonCards count={3} label="Loading expense totals" /> : (!error || hasData) && <StatRow label="Expense totals">
        <Stat label="Total claims" icon={ReceiptText} tone="slate" value={totals.count} active={statusFilter === 'All'} onClick={() => setStatusFilter('All')} />
        <Stat label="Pending" sub="Awaiting a decision" icon={Clock} tone="amber" value={`₹${totals.pending.toLocaleString('en-IN')}`} active={statusFilter === 'Pending'} onClick={() => setStatusFilter('Pending')} />
        <Stat label="Approved" sub="Ready to reimburse or paid" icon={CheckCircle2} tone="green" value={`₹${totals.approved.toLocaleString('en-IN')}`} active={statusFilter === 'Approved'} onClick={() => setStatusFilter('Approved')} />
      </StatRow>}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <div className="premium-card space-y-4">
            <h3 className="font-bold text-xs uppercase tracking-wider text-neutral-800 dark:text-neutral-100 border-b border-neutral-100 dark:border-neutral-900 pb-2.5 flex items-center">
              <FileText size={16} className="mr-2 text-neutral-600 dark:text-neutral-400" /> Claim History
            </h3>
            {/* What to show, with how many: the review queue sits among the states instead of
                being a lone button above the list (round 3). */}
            <div className="choice-pills expense-filter-pills" role="group" aria-label="Show claims">
              {[
                ['All', counts.all],
                canReviewQueue && ['My review queue', reviewBadge?.count],
                ['Pending', counts.pending],
                ['Approved', counts.approved],
                ['Rejected', counts.rejected],
              ].filter(Boolean).map(([filter, count]) => (
                <button key={filter} type="button" className="choice-pill" aria-pressed={statusFilter === filter}
                  aria-label={filter === 'My review queue' ? navigationCountLabel('My review queue', reviewBadge) : undefined}
                  onClick={() => { if (filter === 'My review queue') setMineOnly(false); setStatusFilter(filter); }}>
                  {filter === 'My review queue' ? 'To review' : filter}
                  {filter === 'My review queue' ? <NavigationCountBadge badge={reviewBadge} />
                    : Number.isFinite(count) && count > 0 && <em className="choice-pill-count">{count}</em>}
                </button>
              ))}
            </div>
            {isLoading ? (
              <SkeletonRows rows={4} avatar={false} label="Loading expense claims" />
            ) : visibleExpenses.length === 0 ? error ? null : (
              <p className="text-xs text-neutral-500 py-8 text-center">
                {statusFilter === 'My review queue' ? 'No expense claims need your review.'
                  : `No ${statusFilter === 'All' ? '' : `${statusFilter.toLowerCase()} `}expense claims visible to you yet.`}
              </p>
            ) : (
              <div className="expense-list">
                {pager.slice.map((exp) => {
                  const Icon = categoryIcon(exp.category);
                  const own = exp.employee_id === employee?.id;
                  const decide = canDecide(exp) && exp.status === 'Pending';
                  const meta = [dayMonth(exp.expense_date), !own || canPickWhose ? exp.employee?.full_name : null, exp.employee?.branch?.code].filter(Boolean);
                  return (
                    <div key={exp.id} {...rowProps(exp.id)} className="expense-row">
                      <span className="expense-row-icon" aria-hidden="true"><Icon size={18} /></span>
                      <div className="expense-row-main">
                        <div className="expense-row-top">
                          <strong>{exp.category}</strong>
                          <span className="expense-row-amount">₹{Number(exp.amount).toLocaleString('en-IN')}</span>
                        </div>
                        <span className="expense-row-meta">{meta.join(' · ')}</span>
                        {exp.description && <p className="expense-row-note">{exp.description}</p>}
                        <div className="expense-row-foot">
                          <StatusPill status={exp.status} tone={EXPENSE_TONE[exp.status] ?? 'warning'} />
                          {decide && (
                            <div className="expense-row-decide">
                              <button type="button" className="is-reject" disabled={setStatus.isPending}
                                onClick={() => { if (!setStatus.isPending) setStatus.mutate({ id: exp.id, status: 'Rejected', approverEmployeeId: employee?.id }); }}
                                aria-label={`Reject ${exp.category} claim of ₹${exp.amount}`}><Ban size={14} aria-hidden="true" /> Reject</button>
                              <button type="button" className="is-approve" disabled={setStatus.isPending}
                                onClick={() => { if (!setStatus.isPending) setStatus.mutate({ id: exp.id, status: 'Approved', approverEmployeeId: employee?.id }); }}
                                aria-label={`Approve ${exp.category} claim of ₹${exp.amount}`}><Check size={14} aria-hidden="true" /> Approve</button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="lg:col-span-1">
          <div className="premium-card space-y-3">
            <h3 className="font-bold text-xs uppercase tracking-wider text-neutral-800 dark:text-neutral-100 border-b border-neutral-100 dark:border-neutral-900 pb-2.5">Entitlement Limits</h3>
            <div className="space-y-2 text-xs text-neutral-500 dark:text-neutral-400">
              <Limit k="Local Conveyance" v="₹3,000 / mo" />
              <Limit k="Broadband / Mobile" v="₹1,500 / mo" />
              <Limit k="Medical" v="₹15,000 / yr" />
              <Limit k="Outstation Travel" v="Actual (pre-approved)" />
              
            </div>
          </div>
        </div>
      </div>

      {/* Claim form is an inline section, not a modal: it belongs to the page's flow and the
          policy limits beside it stay readable while you fill it in. */}

      {!isLoading && (!error || hasData) && <Pagination {...pager} noun="claims" />}
    </div>
  );
}

const Stat = ({ label, value, sub, icon, tone, onClick, active = false }) => (
  <StatCard label={label} value={value} sub={sub} icon={icon} tone={tone} onClick={onClick} active={active} title={onClick ? `Show ${label}` : undefined} />
);
const Limit = ({ k, v }) => (
  <div className="flex justify-between border-b border-neutral-100 dark:border-neutral-855 pb-1"><span>{k}</span><span className="text-neutral-800 dark:text-slate-200">{v}</span></div>
);
