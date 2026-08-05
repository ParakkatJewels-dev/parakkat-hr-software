import React, { useState, useMemo } from 'react';
import {
  ListChecks, Plus, X, Loader2, AlertTriangle, Trash2, CornerDownRight, Flag,
  CalendarClock, User, GitBranch, Users, ChevronRight,
} from 'lucide-react';
import { useTasks, useCreateTask, useUpdateTask, useDeleteTask } from '../data/tasks';
import { useEmployees } from '../data/employees';
import { useAuth } from '../auth/AuthContext';
import FormSection from './ui/FormSection';
import { btnClass } from './ui/Btn';
import { usePermissions } from '../auth/usePermissions';
import { useUrlTab } from '../lib/useUrlTab';

const STATUSES = ['To Do', 'In Progress', 'Blocked', 'Done', 'Cancelled'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];

const INPUT =
  'w-full text-sm rounded-xl px-3 py-2 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-[#0ea971] transition-colors';

const statusClass = (s) =>
  s === 'Done'
    ? 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-450 dark:border-emerald-900/30'
    : s === 'In Progress'
    ? 'bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-900/30'
    : s === 'Blocked'
    ? 'bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950/40 dark:text-rose-400 dark:border-rose-900/30'
    : s === 'Cancelled'
    ? 'bg-neutral-100 text-neutral-400 border-neutral-200 dark:bg-neutral-900 dark:text-neutral-500 dark:border-neutral-800'
    : 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-450 dark:border-amber-900/30';

const priorityMeta = (p) =>
  p === 'Urgent'
    ? { dot: 'bg-rose-500', text: 'text-rose-600 dark:text-rose-400' }
    : p === 'High'
    ? { dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' }
    : p === 'Low'
    ? { dot: 'bg-neutral-400', text: 'text-neutral-500' }
    : { dot: 'bg-sky-500', text: 'text-sky-600 dark:text-sky-400' };

const todayStr = () => new Date().toISOString().slice(0, 10);
const isOverdue = (t) => t.due_date && t.due_date < todayStr() && t.status !== 'Done' && t.status !== 'Cancelled';

export default function TaskManagement() {
  const { data: tasks = [], isLoading, error } = useTasks();
  const { data: employees = [] } = useEmployees();
  const { employee } = useAuth();
  const { canAny } = usePermissions();

  const create = useCreateTask();
  const update = useUpdateTask();
  const del = useDeleteTask();

  // A task is assigned to someone (the assignee is picked in the composer), so — unlike leave —
  // the creator need NOT be linked to an employee themselves. Only the permission matters.
  const canCreate = canAny('task.create');
  const canUpdate = canAny('task.update') || canAny('task.manage');
  const canManage = canAny('task.manage');

  // In the URL, so a refresh comes back to the view you were reading.
  const [view, setView] = useUrlTab('flow', ['flow', 'people']);
  const [statusFilter, setStatusFilter] = useState('Active'); // Active | All | Overdue | <status>
  const [mineOnly, setMineOnly] = useState(false);
  const [composer, setComposer] = useState(null); // { parentId, defaultAssignee } | null

  // ---- filtering ----
  const filtered = useMemo(() => {
    return tasks.filter((t) => {
      if (mineOnly && t.employee_id !== employee?.id) return false;
      if (statusFilter === 'All') return true;
      if (statusFilter === 'Active') return t.status !== 'Done' && t.status !== 'Cancelled';
      if (statusFilter === 'Overdue') return isOverdue(t);
      return t.status === statusFilter;
    });
  }, [tasks, mineOnly, statusFilter, employee]);

  const stats = useMemo(() => {
    const scope = mineOnly ? tasks.filter((t) => t.employee_id === employee?.id) : tasks;
    return {
      total: scope.length,
      todo: scope.filter((t) => t.status === 'To Do').length,
      progress: scope.filter((t) => t.status === 'In Progress').length,
      done: scope.filter((t) => t.status === 'Done').length,
      overdue: scope.filter(isOverdue).length,
    };
  }, [tasks, mineOnly, employee]);

  // ---- hierarchy: build parent → children from the FILTERED set ----
  const { roots, childrenOf } = useMemo(() => {
    const ids = new Set(filtered.map((t) => t.id));
    const kids = new Map();
    const rootList = [];
    for (const t of filtered) {
      const parent = t.parent_task_id && ids.has(t.parent_task_id) ? t.parent_task_id : null;
      if (parent) {
        if (!kids.has(parent)) kids.set(parent, []);
        kids.get(parent).push(t);
      } else {
        rootList.push(t);
      }
    }
    return { roots: rootList, childrenOf: kids };
  }, [filtered]);

  // ---- people grouping ----
  const byPerson = useMemo(() => {
    const groups = new Map();
    for (const t of filtered) {
      const key = t.assignee?.id ?? t.employee_id ?? 'unassigned';
      if (!groups.has(key)) groups.set(key, { assignee: t.assignee, tasks: [] });
      groups.get(key).tasks.push(t);
    }
    return [...groups.values()].sort((a, b) =>
      (a.assignee?.full_name || '').localeCompare(b.assignee?.full_name || '')
    );
  }, [filtered]);

  const actions = {
    setStatus: (id, status) => update.mutate({ id, status }),
    addSubtask: (task) => setComposer({ parentId: task.id, defaultAssignee: task.employee_id }),
    remove: (id) => del.mutate(id),
    canUpdate,
    canManage,
    canCreate,
  };

  return (
    <div className="page-shell space-y-6 animate-slide-up">
      <div className="flex flex-wrap justify-between items-center gap-3">
        <div>
          <h1 className="text-xl font-bold text-neutral-900 dark:text-white leading-tight font-sans flex items-center gap-2">
            <ListChecks size={20} className="text-[#0ea971]" /> Task Management
          </h1>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
            Assign work down your branch, zone or entity and track it as it flows through the hierarchy.
          </p>
        </div>
        {canCreate && (
          <button
            onClick={() => setComposer({ parentId: null, defaultAssignee: employee?.id })}
            className={btnClass('primary')}
          >
            <Plus size={14} /> <span>New Task</span>
          </button>
        )}
      </div>

      {/* stats */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <Stat label="Total" value={stats.total} active={statusFilter === 'All'} onClick={() => setStatusFilter('All')} />
        <Stat label="To Do" value={stats.todo} active={statusFilter === 'To Do'} onClick={() => setStatusFilter('To Do')} />
        <Stat label="In Progress" value={stats.progress} active={statusFilter === 'In Progress'} onClick={() => setStatusFilter('In Progress')} />
        <Stat label="Done" value={stats.done} active={statusFilter === 'Done'} onClick={() => setStatusFilter('Done')} />
        <Stat label="Overdue" value={stats.overdue} accent={stats.overdue > 0} active={statusFilter === 'Overdue'} onClick={() => setStatusFilter('Overdue')} />
      </div>

      {/* controls */}
      <div className="mobile-toolbar flex flex-wrap items-center justify-between gap-3">
        <div className="mobile-segmented flex flex-wrap items-center gap-1.5">
          {['Active', 'To Do', 'In Progress', 'Blocked', 'Done', 'Overdue', 'All'].map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              aria-current={statusFilter === s ? 'page' : undefined}
              className={`text-base font-semibold px-2.5 py-1 rounded-lg border cursor-pointer transition-colors ${
                statusFilter === s
                  ? 'bg-black text-white border-black dark:bg-[#0ea971] dark:text-white dark:border-neutral-700'
                  : 'bg-neutral-50 dark:bg-neutral-900 text-neutral-500 border-neutral-200 dark:border-neutral-850 hover:text-neutral-900 dark:hover:text-white'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="mobile-toolbar-actions flex items-center gap-2">
          {employee?.id && (
            <button
              onClick={() => setMineOnly((v) => !v)}
              className={`text-base font-semibold px-2.5 py-1 rounded-lg border cursor-pointer transition-colors ${
                mineOnly
                  ? 'bg-[#0ea971]/15 text-[#0c9765] dark:text-[#10b981] border-[#0ea971]/30'
                  : 'bg-neutral-50 dark:bg-neutral-900 text-neutral-500 border-neutral-200 dark:border-neutral-850 hover:text-neutral-900 dark:hover:text-white'
              }`}
            >
              My tasks
            </button>
          )}
          <div className="flex rounded-lg border border-neutral-200 dark:border-neutral-850 overflow-hidden">
            <ViewBtn active={view === 'flow'} onClick={() => setView('flow')} icon={GitBranch} label="Flow" />
            <ViewBtn active={view === 'people'} onClick={() => setView('people')} icon={Users} label="By Person" />
          </div>
        </div>
      </div>

      {/* body */}
      {isLoading ? (
        <div className="flex justify-center py-16 text-[#0ea971]"><Loader2 size={24} className="animate-spin" /></div>
      ) : error ? (
        <div className="premium-card p-5 flex items-start gap-3 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Couldn't load tasks.</p>
            <p className="text-neutral-500 dark:text-neutral-400 mt-1">
              {error.message}. If it mentions <code>tasks</code>, run migration <code>0017_tasks.sql</code>.
            </p>
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="premium-card p-10 text-center text-xs text-neutral-500">
          No tasks {statusFilter !== 'All' ? `in "${statusFilter}"` : ''} to show.
          {canCreate && ' Create one to get started.'}
        </div>
      ) : view === 'flow' ? (
        <div className="space-y-3">
          {roots.map((t) => (
            <TaskTree key={t.id} task={t} childrenOf={childrenOf} depth={0} actions={actions} />
          ))}
        </div>
      ) : (
        <div className="space-y-5">
          {byPerson.map((g) => (
            <div key={g.assignee?.id ?? 'x'} className="space-y-2.5">
              <div className="flex items-center gap-2 px-1">
                <div className={btnClass('primary')}>
                  {(g.assignee?.full_name || '?').split(' ').filter(Boolean).slice(0, 2).map((s) => s[0]).join('').toUpperCase()}
                </div>
                <span className="font-bold text-sm text-neutral-800 dark:text-slate-100">{g.assignee?.full_name || 'Unassigned'}</span>
                <span className="text-2xs font-mono text-neutral-400">
                  {g.assignee?.employee_code}{g.assignee?.branch?.code ? ` · ${g.assignee.branch.code}` : ''} · {g.tasks.length} task{g.tasks.length !== 1 ? 's' : ''}
                </span>
              </div>
              {g.tasks.map((t) => (
                <TaskCard key={t.id} task={t} actions={actions} subCount={(childrenOf.get(t.id) || []).length} />
              ))}
            </div>
          ))}
        </div>
      )}

      {composer && (
        <TaskComposer
          employees={employees}
          currentEmployeeId={employee?.id}
          parentId={composer.parentId}
          defaultAssignee={composer.defaultAssignee}
          parentTask={composer.parentId ? tasks.find((t) => t.id === composer.parentId) : null}
          busy={create.isPending}
          error={create.error?.message}
          onClose={() => { create.reset(); setComposer(null); }}
          onSubmit={async (payload) => {
            try { await create.mutateAsync(payload); setComposer(null); } catch { /* shown */ }
          }}
        />
      )}
    </div>
  );
}

// Recursive delegation tree — a task with its sub-tasks nested beneath it.
function TaskTree({ task, childrenOf, depth, actions }) {
  const kids = childrenOf.get(task.id) || [];
  return (
    <div className={depth > 0 ? 'ml-4 sm:ml-7 border-l border-neutral-200 dark:border-neutral-850 pl-3 sm:pl-4' : ''}>
      <TaskCard task={task} actions={actions} subCount={kids.length} nested={depth > 0} />
      {kids.length > 0 && (
        <div className="mt-2.5 space-y-2.5"> {kids.map((k) => ( <TaskTree key={k.id} task={k} childrenOf={childrenOf} depth={depth + 1} actions={actions} /> ))} </div> )} </div> );
} function TaskCard({ task, actions, subCount = 0, nested = false }) { const pm = priorityMeta(task.priority); const overdue = isOverdue(task); return ( <div className={`premium-card ${nested ? 'bg-neutral-50/60 dark:bg-neutral-950/30' : ''}`}> <div className="mobile-list-row flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            {nested && <CornerDownRight size={13} className="text-neutral-400 shrink-0" />}
            <span className={`w-2 h-2 rounded-full shrink-0 ${pm.dot}`} title={`${task.priority} priority`} aria-label={`${task.priority} priority`} />
            <span className="font-bold text-sm text-neutral-850 dark:text-slate-100 truncate">{task.title}</span>
            <span className={`text-2xs font-bold uppercase font-mono ${pm.text}`}>{task.priority}</span>
            {subCount > 0 && (
              <span className="text-2xs font-mono px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-900 text-neutral-500 border border-neutral-200 dark:border-neutral-800 flex items-center gap-1">
                <GitBranch size={9} /> {subCount}
              </span>
            )}
          </div>
          {task.description && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400 line-clamp-2">{task.description}</p>
          )}
          <div className="flex items-center gap-3 flex-wrap text-2xs text-neutral-500 dark:text-neutral-400 pt-0.5">
            <span className="inline-flex items-center gap-1">
              <User size={11} className="text-neutral-400" />
              <span className="font-semibold text-neutral-700 dark:text-neutral-300">{task.assignee?.full_name || 'Unassigned'}</span>
              {task.assignee?.branch?.code && <span className="font-mono">· {task.assignee.branch.code}</span>}
            </span>
            {task.assigner && task.assigner.id !== task.assignee?.id && (
              <span className="inline-flex items-center gap-1 font-mono">
                <ChevronRight size={10} /> by {task.assigner.full_name}
              </span>
            )}
            {task.due_date && (
              <span className={`inline-flex items-center gap-1 font-mono ${overdue ? 'text-rose-600 dark:text-rose-400 font-bold' : ''}`}>
                <CalendarClock size={11} /> {task.due_date}{overdue ? ' · overdue' : ''}
              </span>
            )}
          </div>
        </div>

        <div className="mobile-list-actions flex flex-col items-end gap-2 shrink-0">
          {actions.canUpdate ? (
            <select
              value={task.status}
              onChange={(e) => actions.setStatus(task.id, e.target.value)}
              className={`text-2xs font-bold uppercase tracking-wide font-mono rounded-lg px-2 py-1 border cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0ea971]/50 rounded-md ${statusClass(task.status)}`}
            >
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          ) : (
            <span className={`text-2xs px-2 py-0.5 rounded-full font-mono font-bold uppercase tracking-wider border ${statusClass(task.status)}`}>
              {task.status}
            </span>
          )}
          <div className="flex items-center gap-1">
            {actions.canCreate && (
              <button onClick={() => actions.addSubtask(task)} title="Add sub-task" aria-label="Add sub-task"
                className="p-1.5 rounded-lg text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-white cursor-pointer">
                <Plus size={13} />
              </button>
            )}
            {actions.canManage && (
              <button onClick={() => actions.remove(task.id)} title="Delete task" aria-label="Delete task"
                className="p-1.5 rounded-lg text-neutral-400 hover:bg-red-100 hover:text-red-500 dark:hover:bg-red-950/40 cursor-pointer">
                <Trash2 size={13} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TaskComposer({ employees, currentEmployeeId, parentId, defaultAssignee, parentTask, busy, error, onClose, onSubmit }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('Medium');
  const [dueDate, setDueDate] = useState('');
  const [assigneeId, setAssigneeId] = useState(defaultAssignee || currentEmployeeId || '');
  const [q, setQ] = useState('');

  const results = useMemo(() => {
    const s = q.toLowerCase();
    if (!s) return [];
    return employees
      .filter((e) => (e.full_name || '').toLowerCase().includes(s) || (e.employee_code || '').toLowerCase().includes(s))
      .slice(0, 8);
  }, [employees, q]);
  const chosen = employees.find((e) => e.id === assigneeId);

  const submit = (e) => {
    e.preventDefault();
    if (!title.trim() || !assigneeId) return;
    onSubmit({
      title: title.trim(),
      description: description.trim() || null,
      priority,
      due_date: dueDate || null,
      employee_id: assigneeId,
      assigned_by: currentEmployeeId || null,
      parent_task_id: parentId || null,
    });
  };

  return (
    <FormSection
      title={parentId ? 'New sub-task' : 'New task'}
      subtitle={parentId ? undefined : 'Assign work to someone in your scope.'}
      icon={parentId ? CornerDownRight : Plus}
      onClose={onClose}
      onSubmit={submit}
      submitLabel={parentId ? 'Add sub-task' : 'Create task'}
      busy={busy}
      disabled={!title.trim() || !assigneeId}
      error={error}
    >
        {parentTask && (
          <div className="text-xs text-neutral-500 dark:text-neutral-400 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 rounded-xl px-3 py-2 flex items-center gap-1.5">
            <GitBranch size={12} className="text-[#0ea971] shrink-0" /> Under: <span className="font-semibold text-neutral-700 dark:text-neutral-300 truncate">{parentTask.title}</span>
          </div>
        )}

        <div className="space-y-3">
          <div className="space-y-1">
            <label className="block text-base font-semibold text-neutral-600 dark:text-neutral-300">Title</label>
            <input autoFocus className={INPUT} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs to be done?" required />
          </div>

          <div className="space-y-1">
            <label className="block text-base font-semibold text-neutral-600 dark:text-neutral-300">Description (optional)</label>
            <textarea rows={2} className={INPUT + ' resize-none'} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Add detail or context…" />
          </div>

          <div className="space-y-1">
            <label className="block text-base font-semibold text-neutral-600 dark:text-neutral-300">Assign to</label>
            {chosen ? (
              <div className="flex items-center justify-between rounded-xl bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 px-3 py-2 text-xs">
                <span className="font-semibold text-neutral-800 dark:text-neutral-200">
                  {chosen.full_name}
                  <span className="font-mono text-2xs text-neutral-500"> · {chosen.employee_code}{chosen.branch?.code ? ` · ${chosen.branch.code}` : ''}</span>
                  {chosen.id === currentEmployeeId && <span className="ml-1 text-[#0c9765] dark:text-[#10b981]">(me)</span>}
                </span>
                <button type="button" onClick={() => { setAssigneeId(''); setQ(''); }} className="text-neutral-400 hover:text-red-500"><X size={14} /></button>
              </div>
            ) : (
              <>
                <input className={INPUT} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search employee by name or code…" />
                {results.length > 0 && (
                  <div className="mt-1 max-h-40 overflow-y-auto border border-neutral-200 dark:border-neutral-850 rounded-xl divide-y divide-neutral-150 dark:divide-neutral-850/60">
                    {results.map((e) => (
                      <button key={e.id} type="button" onClick={() => setAssigneeId(e.id)}
                        className="w-full text-left px-3 py-2 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-900 flex justify-between items-center cursor-pointer">
                        <span className="font-semibold text-neutral-800 dark:text-neutral-200">{e.full_name}</span>
                        <span className="font-mono text-2xs text-neutral-500">{e.employee_code}{e.branch?.code ? ` · ${e.branch.code}` : ''}</span>
                      </button>
                    ))}
                  </div>
                )}
                {currentEmployeeId && (
                  <button type="button" onClick={() => setAssigneeId(currentEmployeeId)} className="text-xs text-[#0c9765] dark:text-[#10b981] hover:underline cursor-pointer mt-1">
                    Assign to myself
                  </button>
                )}
              </>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-base font-semibold text-neutral-600 dark:text-neutral-300 flex items-center gap-1"><Flag size={11} /> Priority</label>
              <select value={priority} onChange={(e) => setPriority(e.target.value)} className={INPUT}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-base font-semibold text-neutral-600 dark:text-neutral-300 flex items-center gap-1"><CalendarClock size={11} /> Due date</label>
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={INPUT} />
            </div>
          </div>

        </div>
    </FormSection>
  );
}

function ViewBtn({ active, onClick, icon: Icon, label }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 text-base font-semibold px-2.5 py-1 cursor-pointer transition-colors ${
        active
          ? 'bg-black text-white dark:bg-[#0ea971] dark:text-white'
          : 'bg-neutral-50 dark:bg-neutral-900 text-neutral-500 hover:text-neutral-900 dark:hover:text-white'
      }`}
    >
      <Icon size={12} /> {label}
    </button>
  );
}

function Stat({ label, value, accent, onClick, active = false }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      {...(onClick ? { type: 'button', onClick, title: `Show ${label}` } : {})}
      className={`premium-card text-left ${onClick ? 'summary-card-link' : ''} ${active ? 'summary-card-link-active' : ''}`}
    >
      <span className="text-neutral-500 dark:text-neutral-455 text-xs font-bold uppercase tracking-wider block">{label}</span>
      <span className={`text-2xl font-extrabold font-mono block mt-1.5 ${accent ? 'text-rose-500' : 'text-neutral-850 dark:text-slate-100'}`}>{value}</span>
    </Tag>
  );
}
