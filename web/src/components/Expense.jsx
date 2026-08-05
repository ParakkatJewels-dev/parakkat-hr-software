import React, { useState, useMemo } from 'react';
import { FileText, Check, Ban, Loader2, AlertTriangle, Plus } from 'lucide-react';
import { useExpenses, useAddExpense, useSetExpenseStatus } from '../data/expenses';
import { useAuth } from '../auth/AuthContext';
import FormSection, { Field, FIELD } from './ui/FormSection';
import { btnClass } from './ui/Btn';
import Pagination, { usePagination } from './ui/Pagination';
import { usePermissions } from '../auth/usePermissions';

const CATEGORIES = ['Local Conveyance', 'Travel Expenses', 'Telephone/Mobile Bills', 'Medical Claims', 'Office Supplies', 'Other'];

const statusClass = (s) =>
  s === 'Approved' || s === 'Paid'
    ? 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-450 dark:border-emerald-900/30'
    : s === 'Rejected'
    ? 'bg-rose-100 text-rose-805 border-rose-200 dark:bg-rose-950/40 dark:text-rose-450 dark:border-rose-900/30'
    : 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-450 dark:border-amber-900/30';

export default function Expense() {
  const { data: expenses = [], isLoading, error } = useExpenses();
  const { employee } = useAuth();
  const { canAny } = usePermissions();
  const add = useAddExpense();
  const setStatus = useSetExpenseStatus();

  const canApprove = canAny('expense.approve');
  const canClaim = Boolean(employee?.id);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ category: 'Local Conveyance', amount: '', expense_date: '', description: '' });
  const [statusFilter, setStatusFilter] = useState('All');

  const totals = useMemo(() => {
    const sum = (pred) => expenses.filter(pred).reduce((a, e) => a + Number(e.amount || 0), 0);
    return {
      pending: sum((e) => e.status === 'Pending'),
      approved: sum((e) => e.status === 'Approved' || e.status === 'Paid'),
      count: expenses.length,
    };
  }, [expenses]);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.amount || !form.description || !employee?.id) return;
    try {
      await add.mutateAsync({
        employee_id: employee.id,
        category: form.category,
        amount: parseFloat(form.amount),
        expense_date: form.expense_date || null,
        description: form.description,
      });
      setForm({ category: 'Local Conveyance', amount: '', expense_date: '', description: '' });
      setShowForm(false);
    } catch { /* shown below */ }
  };

  const visibleExpenses = useMemo(() => {
    if (statusFilter === 'All') return expenses;
    if (statusFilter === 'Approved') return expenses.filter((e) => e.status === 'Approved' || e.status === 'Paid');
    return expenses.filter((e) => e.status === statusFilter);
  }, [expenses, statusFilter]);

  // Paged: this list grows with the business and was rendering every row.
  const pager = usePagination(visibleExpenses);

  return (
    <div className="page-shell space-y-6 animate-fade-in">
      {showForm && canClaim && (
        <FormSection
          title="Claim reimbursement"
          subtitle="Filed against your own record; your manager approves it."
          icon={Plus}
          onClose={() => { add.reset(); setShowForm(false); }}
          onSubmit={submit}
          submitLabel="Submit claim"
          busy={add.isPending}
          error={add.error?.message}
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

      <div className="mobile-list-row flex justify-between items-center">
        <div>
          <h1 className="text-xl font-bold text-neutral-900 dark:text-white leading-tight font-sans flex items-center gap-2">Expense Management</h1>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
            {canApprove ? 'Review and approve reimbursement claims within your scope.' : 'Submit reimbursement claims and track their status.'}
          </p>
        </div>
        {canClaim && !showForm && (
          <button onClick={() => setShowForm(true)} className={btnClass('primary')}>
            Submit Claim
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <Stat label="Total Claims" value={totals.count} active={statusFilter === 'All'} onClick={() => setStatusFilter('All')} />
        <Stat label="Pending ₹" value={totals.pending.toLocaleString()} active={statusFilter === 'Pending'} onClick={() => setStatusFilter('Pending')} />
        <Stat label="Approved ₹" value={totals.approved.toLocaleString()} active={statusFilter === 'Approved'} onClick={() => setStatusFilter('Approved')} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <div className="premium-card space-y-4">
            <h3 className="font-bold text-xs uppercase tracking-wider text-neutral-800 dark:text-neutral-100 border-b border-neutral-100 dark:border-neutral-900 pb-2.5 flex items-center">
              <FileText size={16} className="mr-2 text-neutral-600 dark:text-neutral-400" /> Claim History
            </h3>
            {isLoading ? (
              <div className="flex justify-center py-10 text-[#0ea971]"><Loader2 size={22} className="animate-spin" /></div>
            ) : error ? (
              <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300 py-3"><AlertTriangle size={15} className="shrink-0 mt-0.5" /> <span>{error.message}</span></div>
            ) : visibleExpenses.length === 0 ? (
              <p className="text-xs text-neutral-500 py-8 text-center">
                No {statusFilter === 'All' ? '' : `${statusFilter.toLowerCase()} `}expense claims visible to you yet.
              </p>
            ) : (
              <div className="space-y-3 max-h-[440px] overflow-y-auto pr-1">
                {pager.slice.map((exp) => (
                  <div key={exp.id} className="mobile-list-row p-3.5 bg-neutral-50 dark:bg-neutral-950/20 border border-neutral-200 dark:border-neutral-900 rounded-xl flex items-center justify-between gap-3 hover:border-neutral-300 dark:hover:border-neutral-800">
                    <div className="space-y-1 min-w-0">
                      <span className="font-semibold text-xs text-neutral-800 dark:text-slate-200">{exp.category}</span>
                      <span className="text-2xs text-neutral-500 block truncate">
                        {exp.expense_date || '—'} · {exp.employee?.full_name || 'Unknown'}
                        {exp.employee?.branch?.code ? ` (${exp.employee.branch.code})` : ''}
                      </span>
                      {exp.description && <p className="text-2xs text-neutral-450 italic truncate">"{exp.description}"</p>}
                    </div>
                    <div className="mobile-list-actions text-right flex flex-col items-end gap-1.5 shrink-0">
                      <span className="font-mono font-bold text-neutral-800 dark:text-slate-100 text-sm">₹{Number(exp.amount).toLocaleString()}</span>
                      <div className="flex items-center gap-1.5">
                        <span className={`text-2xs px-2 py-0.5 rounded-full font-mono font-bold border ${statusClass(exp.status)}`}>{exp.status}</span>
                        {canApprove && exp.status === 'Pending' && (
                          <>
                            <button onClick={() => setStatus.mutate({ id: exp.id, status: 'Approved' })} title="Approve" aria-label="Approve" className="p-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 cursor-pointer"><Check size={13} /></button>
                            <button onClick={() => setStatus.mutate({ id: exp.id, status: 'Rejected' })} title="Reject" aria-label="Reject" className="p-1.5 rounded-lg bg-rose-50 dark:bg-rose-950/30 text-rose-600 dark:text-rose-400 hover:bg-rose-100 cursor-pointer"><Ban size={13} /></button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
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
              <p className="text-2xs text-neutral-400 pt-1">Claims must be filed within 30 days of the bill date.</p>
            </div>
          </div>
        </div>
      </div>

      {/* Claim form is an inline section, not a modal: it belongs to the page's flow and the
          policy limits beside it stay readable while you fill it in. */}

      <Pagination {...pager} noun="claims" />
    </div>
  );
}

const Stat = ({ label, value, onClick, active = false }) => {
  const Tag = onClick ? 'button' : 'div';
  return (
  <Tag
    {...(onClick ? { type: 'button', onClick, title: `Show ${label}` } : {})}
    className={`premium-card text-left ${onClick ? 'summary-card-link' : ''} ${active ? 'summary-card-link-active' : ''}`}
  >
    <span className="text-neutral-500 dark:text-neutral-455 text-xs font-bold uppercase tracking-wider block">{label}</span>
    <span className="text-2xl font-extrabold font-mono text-neutral-850 dark:text-slate-100 block mt-1.5">{value}</span>
  </Tag>
  );
};
const Limit = ({ k, v }) => (
  <div className="flex justify-between border-b border-neutral-100 dark:border-neutral-855 pb-1"><span>{k}</span><span className="text-neutral-800 dark:text-slate-200">{v}</span></div>
);
