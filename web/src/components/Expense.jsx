import React, { useState, useMemo } from 'react';
import { FileText, X, Check, Ban, Loader2, AlertTriangle } from 'lucide-react';
import { useExpenses, useAddExpense, useSetExpenseStatus } from '../data/expenses';
import { useAuth } from '../auth/AuthContext';
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

  return (
    <div className="page-shell space-y-6 animate-fade-in">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-bold text-neutral-900 dark:text-slate-100">Expense Management</h2>
          <p className="text-xs text-neutral-500 dark:text-slate-400">
            {canApprove ? 'Review and approve reimbursement claims within your scope.' : 'Submit reimbursement claims and track their status.'}
          </p>
        </div>
        {canClaim && !showForm && (
          <button onClick={() => setShowForm(true)} className="px-4 py-2 bg-black dark:bg-gold-450 dark:text-charcoal-900 text-white text-xs font-semibold rounded-xl hover:opacity-90 cursor-pointer shadow-md">
            Submit Claim
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <Stat label="Total Claims" value={totals.count} />
        <Stat label="Pending ₹" value={totals.pending.toLocaleString()} />
        <Stat label="Approved ₹" value={totals.approved.toLocaleString()} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <div className="premium-card p-5 space-y-4">
            <h3 className="font-bold text-xs uppercase tracking-wider text-neutral-800 dark:text-neutral-100 border-b border-neutral-100 dark:border-neutral-900 pb-2.5 flex items-center">
              <FileText size={16} className="mr-2 text-neutral-600 dark:text-neutral-400" /> Claim History
            </h3>
            {isLoading ? (
              <div className="flex justify-center py-10 text-gold-500"><Loader2 size={22} className="animate-spin" /></div>
            ) : error ? (
              <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300 py-3"><AlertTriangle size={15} className="shrink-0 mt-0.5" /> <span>{error.message}</span></div>
            ) : expenses.length === 0 ? (
              <p className="text-xs text-neutral-500 py-8 text-center">No expense claims visible to you yet.</p>
            ) : (
              <div className="space-y-3 max-h-[440px] overflow-y-auto pr-1">
                {expenses.map((exp) => (
                  <div key={exp.id} className="p-3.5 bg-neutral-50 dark:bg-neutral-950/20 border border-neutral-200 dark:border-neutral-900 rounded-xl flex items-center justify-between gap-3 hover:border-neutral-300 dark:hover:border-neutral-800">
                    <div className="space-y-1 min-w-0">
                      <span className="font-semibold text-xs text-neutral-800 dark:text-slate-200">{exp.category}</span>
                      <span className="text-[10px] text-neutral-500 block truncate">
                        {exp.expense_date || '—'} · {exp.employee?.full_name || 'Unknown'}
                        {exp.employee?.branch?.code ? ` (${exp.employee.branch.code})` : ''}
                      </span>
                      {exp.description && <p className="text-[10px] text-neutral-450 italic truncate">"{exp.description}"</p>}
                    </div>
                    <div className="text-right flex flex-col items-end gap-1.5 shrink-0">
                      <span className="font-mono font-bold text-neutral-800 dark:text-slate-100 text-sm">₹{Number(exp.amount).toLocaleString()}</span>
                      <div className="flex items-center gap-1.5">
                        <span className={`text-[9px] px-2 py-0.5 rounded-full font-mono font-bold border ${statusClass(exp.status)}`}>{exp.status}</span>
                        {canApprove && exp.status === 'Pending' && (
                          <>
                            <button onClick={() => setStatus.mutate({ id: exp.id, status: 'Approved' })} title="Approve" className="p-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 cursor-pointer"><Check size={13} /></button>
                            <button onClick={() => setStatus.mutate({ id: exp.id, status: 'Rejected' })} title="Reject" className="p-1.5 rounded-lg bg-rose-50 dark:bg-rose-950/30 text-rose-600 dark:text-rose-400 hover:bg-rose-100 cursor-pointer"><Ban size={13} /></button>
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
          <div className="premium-card p-5 space-y-3">
            <h3 className="font-bold text-xs uppercase tracking-wider text-neutral-800 dark:text-neutral-100 border-b border-neutral-100 dark:border-neutral-900 pb-2.5">Entitlement Limits</h3>
            <div className="space-y-2 text-xs text-neutral-500 dark:text-neutral-400">
              <Limit k="Local Conveyance" v="₹3,000 / mo" />
              <Limit k="Broadband / Mobile" v="₹1,500 / mo" />
              <Limit k="Medical" v="₹15,000 / yr" />
              <Limit k="Outstation Travel" v="Actual (pre-approved)" />
              <p className="text-[10px] text-neutral-400 pt-1">Claims must be filed within 30 days of the bill date.</p>
            </div>
          </div>
        </div>
      </div>

      {showForm && canClaim && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4 animate-fade-in" onClick={() => setShowForm(false)}>
          <div className="w-full max-w-md bg-white dark:bg-charcoal-900 border border-neutral-200 dark:border-gold-500/15 rounded-2xl shadow-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold">Claim Reimbursement</h3>
              <button onClick={() => setShowForm(false)} className="p-1.5 rounded-lg text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer"><X size={15} /></button>
            </div>
            <form onSubmit={submit} className="space-y-3 text-xs">
              <div className="space-y-1">
                <label className="text-neutral-500 font-semibold">Category</label>
                <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="w-full bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 rounded-xl px-3 py-2 focus:outline-none focus:border-gold-500">
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-neutral-500 font-semibold">Amount (₹)</label>
                  <input type="number" required min="0" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className="w-full bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 rounded-xl px-3 py-2 focus:outline-none focus:border-gold-500" />
                </div>
                <div className="space-y-1">
                  <label className="text-neutral-500 font-semibold">Date</label>
                  <input type="date" value={form.expense_date} onChange={(e) => setForm({ ...form, expense_date: e.target.value })} className="w-full bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 rounded-xl px-3 py-2 focus:outline-none focus:border-gold-500" />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-neutral-500 font-semibold">Description</label>
                <textarea required rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="w-full bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 rounded-xl px-3 py-2 focus:outline-none focus:border-gold-500 resize-none" />
              </div>
              {add.error && <p className="text-[11px] text-red-500">{add.error.message}</p>}
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => setShowForm(false)} className="px-3 py-2 text-xs font-semibold text-neutral-500 hover:text-neutral-900 dark:hover:text-white cursor-pointer">Cancel</button>
                <button type="submit" disabled={add.isPending} className="px-3.5 py-2 bg-black dark:bg-gold-450 dark:text-charcoal-900 text-white text-xs font-semibold rounded-xl hover:opacity-90 disabled:opacity-60 cursor-pointer flex items-center gap-1.5">
                  {add.isPending && <Loader2 size={13} className="animate-spin" />} Submit
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

const Stat = ({ label, value }) => (
  <div className="premium-card p-4.5">
    <span className="text-neutral-500 dark:text-neutral-455 text-[10px] font-bold uppercase tracking-wider block">{label}</span>
    <span className="text-2xl font-extrabold font-mono text-neutral-850 dark:text-slate-100 block mt-1.5">{value}</span>
  </div>
);
const Limit = ({ k, v }) => (
  <div className="flex justify-between border-b border-neutral-100 dark:border-neutral-855 pb-1"><span>{k}</span><span className="text-neutral-800 dark:text-slate-200">{v}</span></div>
);
