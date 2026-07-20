import React, { useState } from 'react';
import { HelpCircle, MailOpen, Plus, X, Loader2, AlertTriangle } from 'lucide-react';
import { useTickets, useAddTicket, useSetTicketStatus } from '../data/tickets';
import { useExits } from '../data/exits';
import { useAuth } from '../auth/AuthContext';
import { usePermissions } from '../auth/usePermissions';

const CATS = ['IT Support', 'Payroll Query', 'HR Policy', 'Facility/Admin'];
const PRIOS = ['Low', 'Medium', 'High'];

const statusClass = (s) =>
  s === 'Resolved'
    ? 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-450 dark:border-emerald-900/30'
    : s === 'In Progress'
    ? 'bg-blue-105 text-blue-800 border-blue-200 dark:bg-blue-950/40 dark:text-blue-450 dark:border-blue-900/30'
    : 'bg-neutral-105 text-neutral-500 border-neutral-200 dark:bg-neutral-900 dark:text-neutral-450 dark:border-neutral-800';

export default function HelpdeskExit() {
  const { data: tickets = [], isLoading, error } = useTickets();
  const { employee } = useAuth();
  const { canAny } = usePermissions();
  const add = useAddTicket();
  const setStatus = useSetTicketStatus();

  const canRaise = Boolean(employee?.id);
  const canHandle = canAny('ticket.manage');

  const { data: exits = [] } = useExits();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ category: 'IT Support', subject: '', priority: 'Medium' });

  const submit = async (e) => {
    e.preventDefault();
    if (!form.subject || !employee?.id) return;
    try {
      await add.mutateAsync({ employee_id: employee.id, category: form.category, subject: form.subject, priority: form.priority });
      setForm({ category: 'IT Support', subject: '', priority: 'Medium' });
      setShowForm(false);
    } catch { /* shown below */ }
  };

  return (
    <div className="page-shell space-y-6 animate-slide-up text-xs">
      <div className="flex justify-between items-center border-b border-neutral-100 dark:border-neutral-900 pb-3">
        <div>
          <h2 className="text-xl font-bold text-neutral-900 dark:text-slate-100 font-sans">Helpdesk &amp; Separation</h2>
          <p className="text-xs text-neutral-500 dark:text-slate-400">Raise support tickets and track exit clearances.</p>
        </div>
        {canRaise && !showForm && (
          <button onClick={() => setShowForm(true)} className="flex items-center gap-1 px-3 py-1.5 bg-black dark:bg-gold-450 dark:text-charcoal-900 text-[11px] font-semibold rounded-xl text-white cursor-pointer shadow-md">
            <Plus size={12} /> Raise Ticket
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* tickets */}
        <div className="space-y-4">
          {showForm && canRaise ? (
            <div className="premium-card p-4 space-y-4 animate-fade-in">
              <div className="flex justify-between items-center border-b border-neutral-100 dark:border-neutral-900 pb-2">
                <h3 className="font-bold text-xs uppercase tracking-wider text-neutral-800 dark:text-neutral-150">Raise Support Ticket</h3>
                <button onClick={() => setShowForm(false)} className="p-1 hover:bg-neutral-100 dark:hover:bg-neutral-900 rounded text-neutral-450 cursor-pointer"><X size={15} /></button>
              </div>
              <form onSubmit={submit} className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Category"><select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className={INPUT}>{CATS.map((c) => <option key={c}>{c}</option>)}</select></Field>
                  <Field label="Priority"><select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} className={INPUT}>{PRIOS.map((p) => <option key={p}>{p}</option>)}</select></Field>
                </div>
                <Field label="Subject"><textarea required rows={3} placeholder="Describe your issue…" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} className={`${INPUT} resize-none`} /></Field>
                {add.error && <p className="text-[11px] text-red-500">{add.error.message}</p>}
                <div className="flex justify-end gap-2 pt-1">
                  <button type="button" onClick={() => setShowForm(false)} className="px-3 py-2 text-xs font-semibold text-neutral-500 hover:text-neutral-900 dark:hover:text-white cursor-pointer">Cancel</button>
                  <button type="submit" disabled={add.isPending} className="px-3.5 py-2 bg-black dark:bg-gold-450 dark:text-charcoal-900 text-white text-xs font-semibold rounded-xl hover:opacity-90 disabled:opacity-60 cursor-pointer flex items-center gap-1.5">{add.isPending && <Loader2 size={13} className="animate-spin" />} Submit</button>
                </div>
              </form>
            </div>
          ) : (
            <div className="premium-card p-4 space-y-3.5">
              <h3 className="font-bold text-xs uppercase tracking-wider text-neutral-800 dark:text-neutral-250 flex items-center border-b border-neutral-100 dark:border-neutral-900 pb-2">
                <HelpCircle size={16} className="mr-2 text-neutral-600 dark:text-neutral-400" /> Support Tickets
              </h3>
              {isLoading ? (
                <div className="flex justify-center py-8 text-gold-500"><Loader2 size={20} className="animate-spin" /></div>
              ) : error ? (
                <div className="flex items-start gap-2 text-amber-700 dark:text-amber-300 py-2"><AlertTriangle size={14} className="shrink-0 mt-0.5" /> <span>{error.message}</span></div>
              ) : tickets.length === 0 ? (
                <p className="text-neutral-500 py-6 text-center">No tickets visible to you yet.</p>
              ) : (
                <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
                  {tickets.map((t) => (
                    <div key={t.id} className="p-3 bg-neutral-50 dark:bg-neutral-950/20 border border-neutral-200 dark:border-neutral-900 rounded-xl flex items-center justify-between gap-3 hover:border-neutral-300 dark:hover:border-neutral-800">
                      <div className="space-y-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-bold text-neutral-850 dark:text-slate-205">{t.category}</span>
                          <span className={`text-[9px] font-mono font-bold ${t.priority === 'High' ? 'text-red-600 dark:text-red-405' : t.priority === 'Medium' ? 'text-amber-600 dark:text-amber-450' : 'text-blue-600 dark:text-blue-450'}`}>{t.priority}</span>
                        </div>
                        <p className="text-xs text-neutral-800 dark:text-slate-300 truncate max-w-[240px]">{t.subject}</p>
                        <span className="text-[10px] text-neutral-500 block">{t.employee?.full_name || 'Unknown'}{t.employee?.branch?.code ? ` · ${t.employee.branch.code}` : ''}</span>
                      </div>
                      <div className="shrink-0 flex items-center gap-1.5">
                        <span className={`text-[9px] px-2 py-0.5 rounded-full font-mono font-bold uppercase border ${statusClass(t.status)}`}>{t.status}</span>
                        {canHandle && t.status !== 'Resolved' && (
                          <select
                            value={t.status}
                            onChange={(e) => setStatus.mutate({ id: t.id, status: e.target.value })}
                            className="text-[9px] bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded px-1 py-0.5 cursor-pointer"
                          >
                            <option>Open</option><option>In Progress</option><option>On Hold</option><option>Resolved</option>
                          </select>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* exits (sample data for now) */}
        <div className="space-y-4">
          <div className="premium-card p-4 space-y-3.5">
            <h3 className="font-bold text-xs uppercase tracking-wider text-neutral-850 dark:text-neutral-100 border-b border-neutral-100 dark:border-neutral-900 pb-2 flex items-center">
              <MailOpen size={16} className="mr-2 text-neutral-600 dark:text-neutral-400" /> Exit Clearances
            </h3>
            {exits.length === 0 ? (
              <p className="text-neutral-500 py-6 text-center">No exit records visible to you.</p>
            ) : (
            <div className="space-y-3.5 max-h-[420px] overflow-y-auto pr-1">
              {exits.map((ext) => (
                <div key={ext.id} className="p-3 bg-neutral-50 dark:bg-neutral-950/20 border border-neutral-200 dark:border-neutral-900 rounded-xl space-y-3">
                  <div className="flex justify-between items-start">
                    <div>
                      <h4 className="font-bold text-xs text-neutral-805 dark:text-slate-200">{ext.employee?.full_name || '—'}</h4>
                      <span className="text-[10px] text-neutral-500 block">Dept: {ext.employee?.department?.name || '—'} · Last Day: {ext.last_day || '—'}</span>
                    </div>
                    <span className="text-[9px] px-2 py-0.5 bg-neutral-200 dark:bg-neutral-900 text-neutral-550 dark:text-neutral-400 rounded-full font-mono border border-neutral-300 dark:border-neutral-800">{ext.status}</span>
                  </div>
                  <div className="border-t border-neutral-100 dark:border-neutral-900/60 pt-2.5 grid grid-cols-4 gap-2 text-[9.5px]">
                    {Object.keys(ext.approvals || {}).map((dept) => (
                      <div key={dept} className={`p-1.5 rounded-lg border text-center font-mono ${ext.approvals[dept] === 'Approved' ? 'bg-emerald-100/50 border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-900/20 dark:text-emerald-450 text-emerald-800' : 'bg-neutral-105 border-neutral-200 dark:bg-neutral-900 dark:border-neutral-800 text-neutral-500'}`}>
                        <span className="block font-bold text-[8.5px] uppercase">{dept}</span>
                        <span className="block text-[8px] font-semibold mt-0.5">{ext.approvals[dept]}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const INPUT = 'w-full text-xs rounded-xl px-3 py-1.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-gold-500 font-medium';
const Field = ({ label, children }) => (
  <div className="space-y-1"><label className="text-neutral-500 font-semibold uppercase text-[9px] tracking-wider">{label}</label>{children}</div>
);
