// Goals & KRAs.
//
// Deliberately not a full appraisal system: Parakkat does not run formal review cycles, so this
// tracks objectives and progress only — no ratings, no self-appraisal forms. Backed by the real
// `goals` table (migration 0043), scoped by RLS: you always see your own, managers with
// performance.manage see and set their team's.
import React, { useMemo, useState } from 'react';
import { Target, Plus, Trash2, Check, X } from 'lucide-react';
import { useGoals, useSaveGoal, useDeleteGoal } from '../data/goals';
import { useAuth } from '../auth/AuthContext';
import { usePermissions } from '../auth/usePermissions';
import { useUrlTab } from '../lib/useUrlTab';
import { SkeletonRows } from './ui/Skeleton';
import { btnClass } from './ui/Btn';
import Pagination, { usePagination } from './ui/Pagination';
import ListSearch from './ui/ListSearch';
import { istToday } from '../lib/dates';
import GoalForm from './GoalForm';
import QueryError from './ui/QueryError';
import { FormError } from './ui/FormSection';

const INPUT =
  'w-full min-h-11 text-sm rounded-xl px-3 py-2 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 text-neutral-800 dark:text-neutral-200';
const fmtDate = (iso) => {
  if (!iso) return null;
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
};

const isOverdue = (g) =>
  g.status === 'Active' && g.target_date && g.target_date.slice(0, 10) < istToday();

export default function Performance() {
  const goalsQuery = useGoals();
  const { data: goals = [], isLoading, error, isFetching, refetch } = goalsQuery;
  const hasData = Array.isArray(goalsQuery.data);
  const { employee } = useAuth();
  const { canAny, can, viewingAsEmployee } = usePermissions();
  const canManage = !viewingAsEmployee && canAny('performance.manage');
  const canManageGoal = (goal) => can('performance.manage', {
    entityId: goal.entity_id, zoneId: goal.zone_id, branchId: goal.branch_id,
    deptId: goal.department_id, employeeId: goal.employee_id,
  });

  const save = useSaveGoal();
  const del = useDeleteGoal();

  const [formOpen, setFormOpen] = useState(false);
  const [created, setCreated] = useState(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('All');
  // In the URL, so a refresh comes back to the view you were reading — but only among the views
  // this person actually has. The tab bar is already hidden without performance.manage; passing the
  // whole catalogue here meant typing /performance/team still selected the team view. Payroll.jsx
  // documents the same bug class and fixes it the same way.
  const [view, setView] = useUrlTab('mine', canManage ? ['mine', 'team'] : ['mine']);

  const mine = useMemo(() => goals.filter((g) => g.employee_id === employee?.id), [goals, employee]);
  const team = useMemo(() => goals.filter((g) => g.employee_id !== employee?.id), [goals, employee]);
  const shown = view === 'mine' ? mine : team;
  const matching = useMemo(() => {
    const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return shown.filter((goal) => {
      if (status === 'Overdue' ? !isOverdue(goal) : status !== 'All' && goal.status !== status) return false;
      const text = [goal.title, goal.employee?.full_name, goal.employee?.employee_code, goal.employee?.department?.name, goal.status].join(' ').toLocaleLowerCase();
      return terms.every((term) => text.includes(term));
    });
  }, [shown, search, status]);

  const setProgress = (g, progress) =>
    save.mutate({ id: g.id, progress, status: progress >= 100 ? 'Completed' : 'Active' });

  // Paged: this list grows with the business and was rendering every row.
  // Above the early return — a hook must run in the same order on every render.
  const pager = usePagination(matching, 25, created?.id, `${view}:${search}:${status}`);

  return (
    <div className="page-shell space-y-5 animate-fade-in">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
        <h1 className="text-xl font-bold text-neutral-900 dark:text-white leading-tight font-sans flex items-center gap-2">
          <Target size={20} className="text-brand-ink" /> Goals &amp; KRAs
        </h1>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
          Track objectives and progress. {canManage ? "Set goals for your team and follow them through." : 'Update progress on your own goals.'}
        </p>
        </div>
        {canManage && !formOpen && <button type="button" className={btnClass('primary')}
          onClick={() => { setCreated(null); setFormOpen(true); }}><Plus size={16} />Set a goal</button>}
      </div>

      <QueryError error={error} title={hasData ? 'Goals could not be refreshed.' : 'Goals could not be loaded.'}
        onRetry={refetch} retrying={isFetching} hasData={hasData} />

      {canManage && formOpen && <GoalForm onClose={() => setFormOpen(false)} onCreated={(goal) => {
        setCreated(goal); setFormOpen(false); setSearch(''); setStatus('All');
        setView(goal.employeeId === employee?.id ? 'mine' : 'team');
      }} />}
      {created && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">Goal assigned to {created.employeeName}.</p>}

      {canManage && (
        <div className="mobile-segmented flex gap-1.5">
          {[['mine', `My goals${hasData ? ` (${mine.length})` : ''}`], ['team', `Team goals${hasData ? ` (${team.length})` : ''}`]].map(([k, label]) => (
            <button
              key={k}
              onClick={() => { setCreated(null); setView(k); }}
              aria-current={view === k ? 'page' : undefined}
              className={`rounded-lg px-3 py-1.5 text-base font-bold cursor-pointer transition-colors ${
                view === k
                  ? 'bg-brand/15 text-brand-ink border border-brand/25'
                  : 'bg-neutral-100 dark:bg-charcoal-800 text-neutral-500 border border-transparent hover:text-neutral-800 dark:hover:text-warm-gray-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <FormError message={save.error || del.error} />
      <div className="grid items-end gap-3 sm:grid-cols-[1fr_12rem]">
        <ListSearch value={search} onChange={(value) => { setCreated(null); setSearch(value); }} label="Search goals" placeholder="Search goal, employee, code or status…" />
        <label className="space-y-1 text-sm"><span>Goal status</span><select className={INPUT} value={status}
          onChange={(event) => { setCreated(null); setStatus(event.target.value); }}>
          {['All', 'Active', 'Overdue', 'Completed', 'Dropped'].map(value => <option key={value} value={value}>{value === 'All' ? 'All goals' : value}</option>)}
        </select></label>
      </div>

      {isLoading ? <SkeletonRows rows={5} label="Loading goals" /> : matching.length === 0 ? error ? null : (
        <div className="premium-card p-8 text-center text-xs text-neutral-500">
          {search.trim() || status !== 'All' ? 'No goals match these filters.' : view === 'mine' ? 'No goals set for you yet.' : 'No goals set for your team yet.'}
        </div>
      ) : (
        <div className="space-y-2">
          {pager.slice.map((g) => {
            const own = g.employee_id === employee?.id;
            const manage = canManageGoal(g);
            return (
              <article key={g.id} className="premium-card" data-focus-row={created?.id === g.id ? '' : undefined}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="break-words text-base font-bold text-neutral-900 dark:text-white">{g.title}</span>
                      {g.status !== 'Active' && (
                        <span className={`text-2xs font-bold uppercase px-1.5 py-0.5 rounded ${g.status === 'Completed' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400' : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'}`}>
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
                    {g.description && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-neutral-600 dark:text-neutral-400">{g.description}</p>}
                  </div>
                  {manage && (
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
                      className={`h-full rounded-full transition-all ${g.progress >= 100 ? 'bg-emerald-500' : 'bg-brand-action'}`}
                      style={{ width: `${Math.max(0, Math.min(100, g.progress))}%` }}
                    />
                  </div>
                  <span className="text-base font-bold font-mono text-neutral-700 dark:text-neutral-200 w-10 text-right">
                    {g.progress}%
                  </span>
                </div>

                {(own || manage) && g.status === 'Active' && (
                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                    {[0, 25, 50, 75].map((p) => (
                      <button
                        key={p}
                        onClick={() => setProgress(g, p)}
                        disabled={save.isPending}
                        className="rounded-lg border border-neutral-200 dark:border-neutral-800 px-2 py-1 text-2xs font-semibold text-neutral-600 dark:text-neutral-300 hover:border-brand/40 cursor-pointer"
                      >
                        {p}%
                      </button>
                    ))}
                    <button
                      onClick={() => setProgress(g, 100)}
                      disabled={save.isPending}
                      className="inline-flex items-center gap-1 rounded-lg bg-brand-action hover:bg-brand-action-hover px-2.5 py-1 text-2xs font-bold text-brand-on cursor-pointer"
                    >
                      <Check size={10} /> Done
                    </button>
                    {manage && (
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

      {!isLoading && (!error || hasData) && <Pagination {...pager} noun="goals" />}
    </div>
  );
}
