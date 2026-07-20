import React from 'react';
import { DollarSign, FileText, Loader2, AlertTriangle } from 'lucide-react';
import { usePayslips } from '../data/payroll';
import { useAuth } from '../auth/AuthContext';

const money = (n) => (n == null ? '—' : `₹${Number(n).toLocaleString()}`);

const statusClass = (s) =>
  s === 'Paid'
    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-450'
    : s === 'Processed'
    ? 'bg-blue-105 text-blue-800 dark:bg-blue-950/40 dark:text-blue-450'
    : 'bg-neutral-200 text-neutral-500 dark:bg-neutral-900 dark:text-neutral-455';

export default function Payroll() {
  const { data: payslips = [], isLoading, error } = usePayslips();
  const { employee } = useAuth();
  const salary = employee?.salary || null;

  return (
    <div className="page-shell space-y-6 animate-fade-in">
      <div className="border-b border-neutral-100 dark:border-neutral-900 pb-3">
        <h2 className="text-xl font-bold text-neutral-900 dark:text-slate-100 font-sans">Payroll</h2>
        <p className="text-xs text-neutral-500 dark:text-slate-400">Payslips within your scope (your own, or your team's for HR/managers).</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1">
          <div className="premium-card p-5 space-y-4">
            <h3 className="font-bold text-xs uppercase tracking-wider text-neutral-800 dark:text-neutral-250 flex items-center border-b border-neutral-100 dark:border-neutral-900 pb-2.5">
              <DollarSign size={16} className="mr-2 text-neutral-600 dark:text-neutral-400" /> My CTC
            </h3>
            {salary ? (
              <div className="space-y-2 text-xs text-neutral-500 font-mono">
                <Row k="Annual CTC" v={money(salary.ctc)} strong />
                <Row k="Base (monthly)" v={money(salary.base)} />
                <Row k="HRA" v={money(salary.hra)} />
                <Row k="Special" v={money(salary.special)} />
                <Row k="PF" v={money(salary.pf)} neg />
                <Row k="TDS" v={money(salary.tds)} neg />
              </div>
            ) : (
              <p className="text-[11px] text-neutral-400">No salary structure on your record yet. HR sets this on the employee profile.</p>
            )}
          </div>
        </div>

        <div className="lg:col-span-2">
          <div className="premium-card p-5 space-y-4">
            <h3 className="font-bold text-xs uppercase tracking-wider text-neutral-850 dark:text-neutral-100 border-b border-neutral-100 dark:border-neutral-900 pb-2.5 flex items-center">
              <FileText size={16} className="mr-2 text-neutral-600 dark:text-neutral-400" /> Payslips
            </h3>
            {isLoading ? (
              <div className="flex justify-center py-10 text-gold-500"><Loader2 size={22} className="animate-spin" /></div>
            ) : error ? (
              <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300 py-3"><AlertTriangle size={15} className="shrink-0 mt-0.5" /> <span>{error.message}</span></div>
            ) : payslips.length === 0 ? (
              <p className="text-xs text-neutral-500 py-8 text-center">No payslips generated yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="premium-table">
                  <thead><tr><th>Period</th><th>Employee</th><th>Gross</th><th>Deductions</th><th>Net</th><th className="text-right">Status</th></tr></thead>
                  <tbody className="font-mono">
                    {payslips.map((p) => (
                      <tr key={p.id}>
                        <td className="font-sans font-semibold text-neutral-805 dark:text-slate-300">{p.period}</td>
                        <td className="font-sans">{p.employee?.full_name || '—'}{p.employee?.branch?.code ? ` (${p.employee.branch.code})` : ''}</td>
                        <td>{money(p.gross)}</td>
                        <td className="text-red-600 dark:text-red-400">{money(p.deductions)}</td>
                        <td className="text-emerald-600 dark:text-emerald-450 font-bold">{money(p.net)}</td>
                        <td className="text-right font-sans"><span className={`px-2 py-0.5 rounded-full text-[8.5px] font-bold uppercase ${statusClass(p.status)}`}>{p.status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const Row = ({ k, v, strong, neg }) => (
  <div className={`flex justify-between ${strong ? 'text-neutral-800 dark:text-white font-bold border-b border-neutral-100 dark:border-neutral-900 pb-1' : ''} ${neg ? 'text-red-600 dark:text-red-400' : ''}`}>
    <span>{k}</span><span>{v}</span>
  </div>
);
