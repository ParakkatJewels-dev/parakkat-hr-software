// Goals & KRAs.
//
// Deliberately not a full appraisal system: Parakkat does not run formal review cycles, so this
// tracks objectives and progress only — no ratings, no self-appraisal forms. Backed by the real
// `goals` table (migration 0043), scoped by RLS: you always see your own, managers with
// performance.manage see and set their team's.
import React, { useMemo, useState } from 'react';
import { Target, Plus, Loader2, AlertTriangle, Trash2, Check, X } from 'lucide-react';
import { useGoals, useSaveGoal, useDeleteGoal } from '../data/goals';
import { useEmployees } from '../data/employees';
import { useAuth } from '../auth/AuthContext';
import { usePermissions } from '../auth/usePermissions';
import { SkeletonRows } from './ui/Skeleton';
import { btnClass } from './ui/Btn';
import Pagination, { usePagination } from './ui/Pagination';

const INPUT =
  'w-full text-xs rounded-xl px-3 py-2 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-[#0ea971]/60';
const BTN = btnClass('primary');
const fmtDate = (iso) => {
  if (!iso) return null;
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
};

const isOverdue = (g) =>
  g.status === 'Active' && g.target_date && g.target_date.slice(0, 10) < new Date().toISOString().slice(0, 10);

export default function Performance() {
  const { data: goals = [], isLoading, error } = useGoals();
  const { data: employees = [] } = useEmployees();
  const { employee } = useAuth();
  const { canAny } = usePermissions();
  const canManage = canAny('performance.manage');

  const save = useSaveGoal();
  const del = useDeleteGoal();

  const [form, setForm] = useState({ employee_id: '', title: '', target_date: '', weight: '' });
  const [view, setView] = useState('mine');

  const mine = useMemo(() => goals.filter((g) => g.employee_id === employee?.id), [goals, employee]);
  const team = useMemo(() => goals.filter((g) => g.employee_id !== employee?.id), [goals, employee]);
  const shown = view === 'mine' ? mine : team;

  const submit = async (e) => {
    e.preventDefault();
    try {
      await save.mutateAsync({
        employee_id: form.employee_id,
        title: form.title.trim(),
        target_date: form.target_date || null,
        weight: form.weight === '' ? null : Number(form.weight),
        created_by: employee?.id ?? null,
      });
      setForm({ employee_id: '', title: '', target_date: '', weight: '' });
    } catch { /* surfaced below */ }
  };

  const setProgress = (g, progress) =>
    save.mutate({ id: g.id, progress, status: progress >= 100 ? 'Completed' : 'Active' });

  // Paged: this list grows with the business and was rendering every row.
  // Above the early return — a hook must run in the same order on every render.
  const pager = usePagination(shown);

  if (isLoading) {
    return <div className="page-shell space-y-5"><SkeletonRows rows={5} /></div>;
  }

  return (
    <div className="page-shell space-y-5 animate-fade-in">
      <div>
        <h1 className="text-xl font-bold text-neutral-900 dark:text-white leading-tight font-sans flex items-center gap-2">
          <Target size={20} className="text-[#0ea971]" /> Goals &amp; KRAs
        </h1>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
          Track objectives and progress. {canManage ? "Set goals for your team and follow them through." : 'Update progress on your own goals.'}
        </p>
      </div>

      {error && (
        <div className="premium-card flex items-start gap-2 text-xs text-rose-500">
          <AlertTriangle size={13} className="shrink-0 mt-0.5" /> {error.message}
        </div>
      )}

      {canManage && (
        <form onSubmit={submit} className="premium-card space-y-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">Set a goal</h3>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <select required value={form.employee_id} onChange={(e) => setForm({ ...form, employee_id: e.target.value })} className={INPUT + ' cursor-pointer'}>
              <option value="">For whom…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>{e.full_name} {e.employee_code ? `(${e.employee_code})` : ''}</option>
              ))}
            </select>
            <input required placeholder="Goal, e.g. Reduce stock variance to under 1%" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className={INPUT + ' sm:col-span-2'} />
            <input type="date" value={form.target_date} onChange={(e) => setForm({ ...form, target_date: e.target.value })} className={INPUT} title="Target date" aria-label="Target date" />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={save.isPending} className={BTN}>
              {save.isPending ? <Loader2 size={12} className="animate-spin disabled:opacity-40 disabled:cursor-not-allowed" /> : <Plus size={12} />} Add goal
            </button>
            <span className="text-2xs text-neutral-400">The person can update their own progress; you can edit or remove the goal.</span>
          </div>
          {save.error && <p className="text-xs text-rose-500">{save.error.message}</p>}
        </form>
      )}

      {canManage && (
        <div className="flex gap-1.5">
          {[['mine', `My goals (${mine.length})`], ['team', `Team goals (${team.length})`]].map(([k, label]) => (
            <button
              key={k}
              onClick={() => setView(k)}
              className={`rounded-lg px-3 py-1.5 text-base font-bold cursor-pointer transition-colors ${
                view === k
                  ? 'bg-[#0ea971]/15 text-[#0ea971] border border-[#0ea971]/25'
                  : 'bg-neutral-100 dark:bg-charcoal-800 text-neutral-500 border border-transparent hover:text-neutral-800 dark:hover:text-warm-gray-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {shown.length === 0 ? (
        <div className="premium-card p-8 text-center text-xs text-neutral-500">
          {view === 'mine' ? 'No goals set for you yet.' : 'No goals set for your team yet.'}
        </div>
      ) : (
        <div className="space-y-2">
          {pager.slice.map((g) => {
            const own = g.employee_id === employee?.id;
            return (
              <article key={g.id} className="premium-card">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-base font-bold text-neutral-900 dark:text-white">{g.title}</span>
                      {g.status !== 'Active' && (
                        <span className="text-2xs font-bold uppercase px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
                          {g.status}
                        </span>
                      )}
                      {isOverdue(g) && (
                        <span className="text-2xs font-bold uppercase px-1.5 py-0.5 rounded bg-rose-100 text-rose-600 dark:bg-rose-950/40 dark:text-rose-400">
                          Overdue
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-neutral-500 mt-0.5">
                      {view === 'team' && <>{g.employee?.full_name} · </>}
                      {g.target_date ? `Target ${fmtDate(g.target_date)}` : 'No target date'}
                    </p>
                  </div>
                  {canManage && (
                    <button
                      onClick={() => del.mutate(g.id)}
                      disabled={del.isPending}
                      className="p-1.5 rounded-lg cursor-pointer text-neutral-400 hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-950/40 shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
                      title="Remove goal" aria-label="Remove goal"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>

                <div className="mt-3 flex items-center gap-3">
                  <div className="h-1.5 flex-1 rounded-full bg-neutral-150 dark:bg-charcoal-800 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${g.progress >= 100 ? 'bg-emerald-500' : 'bg-[#0ea971]'}`}
                      style={{ width: `${Math.max(0, Math.min(100, g.progress))}%` }}
                    />
                  </div>
                  <span className="text-base font-bold font-mono text-neutral-700 dark:text-neutral-200 w-10 text-right">
                    {g.progress}%
                  </span>
                </div>

                {(own || canManage) && g.status === 'Active' && (
                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                    {[0, 25, 50, 75].map((p) => (
                      <button
                        key={p}
                        onClick={() => setProgress(g, p)}
                        className="rounded-lg border border-neutral-200 dark:border-neutral-800 px-2 py-1 text-2xs font-semibold text-neutral-600 dark:text-neutral-300 hover:border-[#0ea971]/40 cursor-pointer"
                      >
                        {p}%
                      </button>
                    ))}
                    <button
                      onClick={() => setProgress(g, 100)}
                      className="inline-flex items-center gap-1 rounded-lg bg-[#0ea971] hover:bg-[#0c9765] px-2.5 py-1 text-2xs font-bold text-white cursor-pointer"
                    >
                      <Check size={10} /> Done
                    </button>
                    {canManage && (
                      <button
                        onClick={() => save.mutate({ id: g.id, status: 'Dropped' })}
                        disabled={save.isPending}
                        className="inline-flex items-center gap-1 rounded-lg border border-neutral-200 dark:border-neutral-800 px-2.5 py-1 text-2xs font-semibold text-neutral-500 hover:text-rose-500 cursor-pointer"
                      >
                        <X size={10} /> Drop
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      <Pagination {...pager} noun="goals" />
    </div>
  );
}
