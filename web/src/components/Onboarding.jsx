import React, { useState } from 'react';
import { UserCheck, Clock, Calendar, Loader2, AlertTriangle } from 'lucide-react';
import { useOnboarding, useUpdateOnboarding } from '../data/onboarding';

export default function Onboarding() {
  const { data: list = [], isLoading, error } = useOnboarding();
  const update = useUpdateOnboarding();
  const [selectedId, setSelectedId] = useState(null);
  const selected = list.find((c) => c.id === selectedId) || list[0] || null;

  const toggleTask = (row, taskId) => {
    const tasks = (row.tasks || []).map((t) =>
      t.id === taskId ? { ...t, status: t.status === 'Completed' ? 'Pending' : 'Completed' } : t
    );
    const done = tasks.filter((t) => t.status === 'Completed').length;
    const progress = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
    update.mutate({ id: row.id, progress, tasks });
  };

  return (
    <div className="page-shell space-y-6 animate-slide-up">
      <div>
        <h2 className="text-xl font-bold text-neutral-900 dark:text-slate-100 font-sans">Onboarding</h2>
        <p className="text-xs text-neutral-500 dark:text-slate-400">Pre-boarding checklists for incoming hires within your scope.</p>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16 text-gold-500"><Loader2 size={24} className="animate-spin" /></div>
      ) : error ? (
        <div className="glass-panel p-5 rounded-2xl flex items-start gap-3 text-xs text-amber-700 dark:text-amber-300"><AlertTriangle size={16} className="shrink-0 mt-0.5" /> <span>{error.message}</span></div>
      ) : list.length === 0 ? (
        <div className="premium-card p-16 text-center text-sm text-neutral-500">No onboarding records visible to you yet.</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1">
            <div className="premium-card p-5 space-y-4">
              <h3 className="font-bold text-xs uppercase tracking-wider text-neutral-800 dark:text-neutral-250 border-b border-neutral-100 dark:border-neutral-900 pb-2.5 flex items-center">
                <UserCheck size={16} className="mr-2 text-neutral-600 dark:text-neutral-400" /> Incoming Hires
              </h3>
              <div className="space-y-3">
                {list.map((c) => (
                  <div key={c.id} onClick={() => setSelectedId(c.id)} className={`p-4 rounded-xl border cursor-pointer transition-all ${selected?.id === c.id ? 'bg-neutral-50 dark:bg-neutral-900 border-black dark:border-gold-500' : 'bg-white dark:bg-neutral-950/20 border-neutral-200 dark:border-neutral-900 hover:border-neutral-350 dark:hover:border-neutral-800'}`}>
                    <div className="flex justify-between items-start">
                      <h4 className="font-bold text-xs text-neutral-800 dark:text-slate-200">{c.name}</h4>
                      <span className="text-[9px] text-neutral-500 font-mono">{c.entity?.code}{c.branch?.code ? `·${c.branch.code}` : ''}</span>
                    </div>
                    <span className="text-[10px] text-neutral-500 block mt-0.5">{c.job_title || '—'}</span>
                    <div className="mt-3 space-y-1">
                      <div className="flex justify-between text-[9.5px] text-neutral-500 font-mono"><span>Milestones</span><span className="font-bold">{c.progress || 0}%</span></div>
                      <div className="w-full bg-neutral-200 dark:bg-neutral-950 h-1 rounded-full overflow-hidden border border-neutral-250 dark:border-neutral-900"><div className="bg-black dark:bg-gold-450 h-full transition-all" style={{ width: `${c.progress || 0}%` }} /></div>
                    </div>
                    <div className="flex justify-between text-[9.5px] text-neutral-450 pt-2.5 mt-3 border-t border-neutral-100 dark:border-neutral-900/40"><span className="flex items-center"><Calendar size={10} className="mr-1" /> {c.join_date || '—'}</span></div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="lg:col-span-2">
            {selected ? (
              <div className="premium-card p-5 space-y-5">
                <div className="flex justify-between items-start border-b border-neutral-100 dark:border-neutral-900 pb-4">
                  <div>
                    <h3 className="font-extrabold text-base text-neutral-850 dark:text-slate-100">{selected.name}</h3>
                    <span className="text-xs text-neutral-500">{selected.job_title || '—'} · Joining: {selected.join_date || '—'}</span>
                  </div>
                  <span className={`text-[9px] font-bold font-mono px-2 py-0.5 rounded-full border ${selected.progress === 100 ? 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-450 dark:border-emerald-900/30' : 'bg-amber-105 text-amber-805 border-amber-205 dark:bg-amber-950/45 dark:text-amber-450 dark:border-amber-900/30'}`}>
                    {selected.progress === 100 ? 'Ready to Activate' : 'Incomplete'}
                  </span>
                </div>
                <div className="space-y-5 pl-4 relative before:absolute before:left-[11px] before:top-2 before:bottom-2 before:w-[1px] before:bg-neutral-200 dark:before:bg-neutral-850">
                  {(selected.tasks || []).map((task, idx) => {
                    const done = task.status === 'Completed';
                    return (
                      <div key={task.id} onClick={() => toggleTask(selected, task.id)} className="relative pl-6 group cursor-pointer flex flex-col md:flex-row md:items-center justify-between gap-2.5">
                        <div className={`absolute left-[-18px] top-1.5 w-6 h-6 rounded-full border flex items-center justify-center transition-all ${done ? 'bg-black border-black text-white dark:bg-gold-450 dark:border-gold-450 dark:text-charcoal-900' : 'bg-white border-neutral-300 dark:bg-neutral-950 dark:border-neutral-800 group-hover:border-black dark:group-hover:border-gold-500'}`}>
                          <span className="text-[9px] font-bold">{done ? '✓' : idx + 1}</span>
                        </div>
                        <div className="space-y-0.5">
                          <span className={`text-xs font-semibold block ${done ? 'line-through text-neutral-450' : 'text-neutral-800 dark:text-neutral-200'}`}>{task.title}</span>
                          <span className="text-[10px] text-neutral-400 block font-mono">Assignee: {task.assignee}</span>
                        </div>
                        <span className={`text-[9.5px] font-bold font-mono md:text-right shrink-0 ${done ? 'text-emerald-600 dark:text-emerald-450' : 'text-neutral-450'}`}>{task.status}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="p-3.5 bg-neutral-100 dark:bg-neutral-900/60 border border-neutral-200 dark:border-neutral-900 rounded-xl flex items-start gap-2.5 text-[10.5px] text-neutral-500 dark:text-neutral-450 font-sans">
                  <Clock size={15} className="text-neutral-600 dark:text-neutral-400 mt-0.5 shrink-0" />
                  <p>Toggle steps to mark them complete. Progress updates automatically.</p>
                </div>
              </div>
            ) : (
              <div className="premium-card p-16 text-center text-neutral-550">Select an incoming hire.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
