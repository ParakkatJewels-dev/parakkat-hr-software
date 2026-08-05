import React, { useMemo, useState } from 'react';
import { UserCheck, Clock, Calendar, Loader2, AlertTriangle, CheckCircle2, Users } from 'lucide-react';
import { useOnboarding, useUpdateOnboarding } from '../data/onboarding';
import PageHeader from './ui/PageHeader';

export default function Onboarding() {
  const { data: list = [], isLoading, error } = useOnboarding();
  const update = useUpdateOnboarding();
  const [selectedId, setSelectedId] = useState(null);
  const selected = list.find((c) => c.id === selectedId) || list[0] || null;
  const stats = useMemo(() => {
    const complete = list.filter((c) => c.progress === 100).length;
    const avg = list.length
      ? Math.round(list.reduce((sum, c) => sum + Number(c.progress || 0), 0) / list.length)
      : 0;
    const joiningSoon = list.filter((c) => c.progress !== 100).length;
    return [
      { label: 'Incoming hires', value: list.length, sub: 'Visible in scope', tone: 'green' },
      { label: 'Ready', value: complete, sub: 'All steps complete', tone: 'blue' },
      { label: 'In progress', value: joiningSoon, sub: 'Needs follow-up', tone: 'amber' },
      { label: 'Avg progress', value: list.length ? `${avg}%` : '—', sub: 'Across checklists', tone: 'violet' },
    ];
  }, [list]);

  const toggleTask = (row, taskId) => {
    const tasks = (row.tasks || []).map((t) =>
      t.id === taskId ? { ...t, status: t.status === 'Completed' ? 'Pending' : 'Completed' } : t
    );
    const done = tasks.filter((t) => t.status === 'Completed').length;
    const progress = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
    update.mutate({ id: row.id, progress, tasks });
  };

  return (
    <div className="page-shell people-page space-y-5 animate-slide-up">
      <PageHeader
        eyebrow="People"
        icon={UserCheck}
        title="Onboarding"
        subtitle="Pre-boarding checklists for incoming hires within your scope."
      />

      {isLoading ? (
        <div className="flex justify-center py-16 text-[#0ea971]"><Loader2 size={24} className="animate-spin" /></div>
      ) : error ? (
        <div className="premium-card p-5 flex items-start gap-3 text-xs text-amber-700 dark:text-amber-300"><AlertTriangle size={16} className="shrink-0 mt-0.5" /> <span>{error.message}</span></div>
      ) : list.length === 0 ? (
        <div className="premium-card people-empty-state">
          <Users size={26} />
          <strong>No onboarding records yet</strong>
          <span>Incoming hires will appear here when they are added to onboarding.</span>
        </div>
      ) : (
        <>
        <section className="people-insight-grid">
          {stats.map((stat) => (
            <div key={stat.label} className="people-insight-card" data-tone={stat.tone}>
              <span>{stat.label}</span>
              <strong>{stat.value}</strong>
              <em>{stat.sub}</em>
            </div>
          ))}
        </section>

        <div className="people-workspace grid grid-cols-1 lg:grid-cols-3 gap-5">
          <div className="lg:col-span-1">
            <div className="premium-card people-side-panel space-y-4">
              <div className="people-panel-head">
                <span><UserCheck size={15} /> Incoming hires</span>
                <em>{list.length} records</em>
              </div>
              <div className="space-y-3">
                {list.map((c) => (
                  <button key={c.id} type="button" onClick={() => setSelectedId(c.id)} className={`onboarding-hire-card ${selected?.id === c.id ? 'is-active' : ''}`}>
                    <div className="mobile-list-row flex justify-between items-start">
                      <h4 className="font-bold text-xs text-neutral-800 dark:text-slate-200">{c.name}</h4>
                      <span className="text-2xs text-neutral-500 font-mono">{c.entity?.code}{c.branch?.code ? `·${c.branch.code}` : ''}</span>
                    </div>
                    <span className="text-2xs text-neutral-500 block mt-0.5">{c.job_title || '—'}</span>
                    <div className="mt-3 space-y-1">
                      <div className="flex justify-between text-2xs text-neutral-500 font-mono"><span>Milestones</span><span className="font-bold">{c.progress || 0}%</span></div>
                      <div className="onboarding-progress"><span style={{ width: `${c.progress || 0}%` }} /></div>
                    </div>
                    <div className="flex justify-between text-2xs text-neutral-450 pt-2.5 mt-3 border-t border-neutral-100 dark:border-neutral-900/40"><span className="flex items-center"><Calendar size={10} className="mr-1" /> {c.join_date || '—'}</span></div>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="lg:col-span-2">
            {selected ? (
              <div className="premium-card onboarding-detail-card space-y-5">
                <div className="mobile-list-row flex justify-between items-start border-b border-neutral-100 dark:border-neutral-900 pb-4">
                  <div>
                    <h3 className="font-extrabold text-base text-neutral-850 dark:text-slate-100">{selected.name}</h3>
                    <span className="text-xs text-neutral-500">{selected.job_title || '—'} · Joining: {selected.join_date || '—'}</span>
                  </div>
                  <span className={`text-2xs font-bold font-mono px-2 py-0.5 rounded-full border ${selected.progress === 100 ? 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-450 dark:border-emerald-900/30' : 'bg-amber-105 text-amber-805 border-amber-205 dark:bg-amber-950/45 dark:text-amber-450 dark:border-amber-900/30'}`}>
                    {selected.progress === 100 ? 'Ready to Activate' : 'Incomplete'}
                  </span>
                </div>
                <div className="space-y-5 pl-4 relative before:absolute before:left-[11px] before:top-2 before:bottom-2 before:w-[1px] before:bg-neutral-200 dark:before:bg-neutral-850">
                  {(selected.tasks || []).map((task, idx) => {
                    const done = task.status === 'Completed';
                    return (
                      <button key={task.id} type="button" onClick={() => toggleTask(selected, task.id)} className="onboarding-task-row">
                        <div className={`absolute left-[-18px] top-1.5 w-6 h-6 rounded-full border flex items-center justify-center transition-all ${done ? 'bg-black border-black text-white dark:bg-[#0ea971] dark:border-neutral-700 dark:text-charcoal-900' : 'bg-white border-neutral-300 dark:bg-neutral-950 dark:border-neutral-800 group-hover:border-black dark:group-hover:border-[#0ea971]'}`}>
                          <span className="text-2xs font-bold">{done ? <CheckCircle2 size={12} /> : idx + 1}</span>
                        </div>
                        <div className="space-y-0.5 text-left">
                          <span className={`text-xs font-semibold block ${done ? 'line-through text-neutral-450' : 'text-neutral-800 dark:text-neutral-200'}`}>{task.title}</span>
                          <span className="text-2xs text-neutral-400 block font-mono">Assignee: {task.assignee}</span>
                        </div>
                        <span className={`text-2xs font-bold font-mono md:text-right shrink-0 ${done ? 'text-emerald-600 dark:text-emerald-450' : 'text-neutral-450'}`}>{task.status}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="p-3.5 bg-neutral-100 dark:bg-neutral-900/60 border border-neutral-200 dark:border-neutral-900 rounded-xl flex items-start gap-2.5 text-xs text-neutral-500 dark:text-neutral-450 font-sans">
                  <Clock size={15} className="text-neutral-600 dark:text-neutral-400 mt-0.5 shrink-0" />
                  <p>Toggle steps to mark them complete. Progress updates automatically.</p>
                </div>
              </div>
            ) : (
              <div className="premium-card p-16 text-center text-neutral-550">Select an incoming hire.</div>
            )}
          </div>
        </div>
        </>
      )}
    </div>
  );
}
