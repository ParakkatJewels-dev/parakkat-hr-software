import React, { useState, useMemo, useDeferredValue } from 'react';
import {
  ListChecks, Plus, X, Loader2, AlertTriangle, Trash2, CornerDownRight, Flag,
  CalendarClock, User, GitBranch, Users, ChevronRight, Search, PenLine, ShieldAlert,
} from 'lucide-react';
import { useTasks, useCreateTask, useUpdateTask, useDeleteTask, CLOSED_TASK_WINDOW_DAYS } from '../data/tasks';
import { useEmployees } from '../data/employees';
import { useAuth } from '../auth/AuthContext';
import FormSection from './ui/FormSection';
import ConfirmDialog from './ui/ConfirmDialog';
import { btnClass } from './ui/Btn';
import { usePermissions } from '../auth/usePermissions';
import { useUrlTab } from '../lib/useUrlTab';
// The board's reasoning — filtering, counting, nesting, grouping — lives in lib so it can be
// tested. This file imports Supabase through its data hooks, which the test runner cannot load.
import {
  TASK_STATUSES, TASK_PRIORITIES,
  isOverdue, filterTasks, sortTasks, taskStats, buildTaskTree, groupByPerson, composerKey,
} from '../lib/taskBoard';
import IconInput from './ui/IconInput';
import { istToday } from '../lib/dates';

const INPUT =
  'w-full text-sm rounded-xl px-3 py-2 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-[#0ea971] transition-colors';

// The -450 step is defined for `neutral` only, so the emerald and amber variants that used to be
// here compiled to nothing at all and Done and To Do kept their LIGHT-mode text — emerald-800 on a
// near-black emerald card. The two statuses that failed were the most-read ones. -300 matches the
// sky and rose siblings, which were right all along. The same typo was in eight other screens.
const statusClass = (s) =>
  s === 'Done'
    ? 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900/30'
    : s === 'In Progress'
    ? 'bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-900/30'
    : s === 'Blocked'
    ? 'bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950/40 dark:text-rose-400 dark:border-rose-900/30'
    : s === 'Cancelled'
    ? 'bg-neutral-100 text-neutral-400 border-neutral-200 dark:bg-neutral-900 dark:text-neutral-500 dark:border-neutral-800'
    : 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900/30';

/**
 * What to call an assignee whose employees row this viewer cannot read.
 *
 * NOT "Unassigned" — `tasks.employee_id` is NOT NULL, so no task is ever unassigned. A null
 * `assignee` means only that the embedded `employees` read came back empty for this viewer, and
 * labelling that "Unassigned" told a branch manager that work sitting with somebody in another
 * branch belonged to nobody. Two such people also both read "Unassigned", one under the other.
 */
const ASSIGNEE_HIDDEN = 'Assignee not visible';

// The board holds every open task and a year of finished ones (see useTasks). Said in months
// because that is how people talk about it, and said AT ALL because a search that quietly cannot
// reach a task is worse than one that says where it stops looking.
const WINDOW_MONTHS = Math.round(CLOSED_TASK_WINDOW_DAYS / 30);
const WINDOW_NOTE = `Open tasks never age off this board. Completed and cancelled ones are kept for ${WINDOW_MONTHS} months.`;

const priorityMeta = (p) =>
  p === 'Urgent'
    ? { dot: 'bg-rose-500', text: 'text-rose-600 dark:text-rose-400' }
    : p === 'High'
    ? { dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' }
    : p === 'Low'
    ? { dot: 'bg-neutral-400', text: 'text-neutral-500' }
    : { dot: 'bg-sky-500', text: 'text-sky-600 dark:text-sky-400' };

export default function TaskManagement() {
  const { data: tasks = [], isLoading, error } = useTasks();
  const { data: employees = [] } = useEmployees();
  const { employee } = useAuth();
  const { canAny, can, canBeyondSelf } = usePermissions();

  const create = useCreateTask();
  const update = useUpdateTask();   // the status dropdown
  const edit = useUpdateTask();     // the edit panel — its own instance so the two errors do not
                                    // land on top of each other in different parts of the screen
  const del = useDeleteTask();

  // A task is assigned to someone (the assignee is picked in the composer), so — unlike leave —
  // the creator need NOT be linked to an employee themselves. Only the permission matters.
  const canCreate = canAny('task.create');
  const canViewTeamTasks = canBeyondSelf('task.read');

  /**
   * Per-row authority, mirroring tasks_update / tasks_delete / tasks_create — each of which checks
   * the row's whole ancestry, not merely whether the permission is held somewhere.
   *
   * The blanket canAny versions were drawn on every visible task. For an employee that mattered
   * most: they hold task.update at SELF scope, so canAny was true and an editable status dropdown
   * appeared on every task RLS returned — including a colleague's, where the update silently
   * matched nothing.
   */
  const scopeOf = (t) => ({
    entityId: t.entity_id,
    zoneId: t.zone_id,
    branchId: t.branch_id,
    deptId: t.department_id,
    employeeId: t.employee_id,
  });
  const rowCan = {
    update: (t) => can('task.update', scopeOf(t)) || can('task.manage', scopeOf(t)),
    manage: (t) => can('task.manage', scopeOf(t)),
    // A sub-task is filed against the same assignee, so it is the parent's ancestry that decides.
    create: (t) => can('task.create', scopeOf(t)),
  };

  // In the URL, so a refresh comes back to the view you were reading.
  const [view, setView] = useUrlTab('flow', ['flow', 'people']);
  const [statusFilter, setStatusFilter] = useState('Active'); // Active | All | Overdue | <status>
  const [mineOnly, setMineOnly] = useState(false);
  const [composer, setComposer] = useState(null); // { parentId, defaultAssignee } | { task } | null
  const [toDelete, setToDelete] = useState(null); // the task awaiting confirmation
  const [query, setQuery] = useState('');
  // The box keeps up with typing; re-filtering and re-rendering the tree is allowed to lag a frame.
  const deferredQuery = useDeferredValue(query);
  const effectiveMineOnly = !canViewTeamTasks || mineOnly;
  const effectiveView = canViewTeamTasks ? view : 'flow';

  // One reading of "today" per render, in IST, shared by the filter, the counts and every badge —
  // so a board rendered across midnight cannot disagree with itself about what is late.
  const today = istToday();

  const myEmployeeId = employee?.id ?? null;
  // Sorted before the tree is built, so sub-tasks come out ordered under their parent too.
  const filtered = useMemo(
    () => sortTasks(
      filterTasks(tasks, { mineOnly: effectiveMineOnly, myEmployeeId, statusFilter, query: deferredQuery, today }),
      today
    ),
    [tasks, effectiveMineOnly, myEmployeeId, statusFilter, deferredQuery, today]
  );
  const stats = useMemo(
    () => taskStats(tasks, { mineOnly: effectiveMineOnly, myEmployeeId, query: deferredQuery, today }),
    [tasks, effectiveMineOnly, myEmployeeId, deferredQuery, today]
  );
  const { roots, childrenOf } = useMemo(() => buildTaskTree(filtered), [filtered]);
  const byPerson = useMemo(() => groupByPerson(filtered), [filtered]);

  /**
   * Who this person may file a task against.
   *
   * Mirrors the tasks_insert policy, which checks task.create against the ASSIGNEE's ancestry. The
   * picker offered every employee the viewer could read, and those are different sets: a department
   * head can read their whole branch's directory but may only assign inside their department, so
   * choosing the wrong colleague produced a raw row-level-security error on submit with nothing to
   * explain it. Now they are not offered.
   */
  const canAssignTo = (e) =>
    can('task.create', {
      entityId: e.entity_id, zoneId: e.zone_id, branchId: e.branch_id,
      deptId: e.department_id, employeeId: e.id,
    });

  const actions = {
    today,
    setStatus: (id, status) => update.mutate({ id, status }),
    addSubtask: (task) => setComposer({ parentId: task.id, defaultAssignee: task.employee_id }),
    // A task was write-once: a typo in the title, a date that moved, or the wrong person could only
    // be fixed by deleting it and filing it again — losing its sub-tasks and its history with it.
    // `task.manage` has advertised "Reassign / delete" since 0017 with no way to reassign.
    edit: (task) => { edit.reset(); setComposer({ task }); },
    // Deleting asks first, like every other destructive action in the app (Payroll drafts,
    // documents, org units). It was a single unguarded click on an icon sitting next to
    // "add sub-task", it cannot be undone, and it detaches any sub-tasks filed under it.
    remove: (task) => { del.reset(); setToDelete(task); },
    // Functions of the row, not booleans: tasks_update, _delete and _insert each check the whole
    // ancestry, so "may I" is a question about THIS task and not about the module.
    canUpdate: rowCan.update,
    canManage: rowCan.manage,
    canCreate: rowCan.create,
  };

  return (
    <div className="page-shell space-y-6 animate-slide-up">
      <div className="flex flex-wrap justify-between items-center gap-3">
        <div>
          <h1 className="text-xl font-bold text-neutral-900 dark:text-white leading-tight font-sans flex items-center gap-2">
            <ListChecks size={20} className="text-[#0ea971]" /> {canViewTeamTasks ? 'Task Management' : 'My Tasks'}
          </h1>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
            {canViewTeamTasks
              ? 'Assign work down your branch, zone or entity and track it as it flows through the hierarchy.'
              : 'Track your assigned work and update its status.'}
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

      {/* search */}
      <div className="flex flex-wrap items-center gap-3">
        <IconInput
          icon={Search}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search tasks"
          placeholder={
            canViewTeamTasks
              ? 'Search a task, a person, a code or a branch…'
              : 'Search your tasks…'
          }
          className="flex-1 min-w-0 sm:max-w-md"
          inputClassName={INPUT}
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            className={btnClass('ghost')}
          >
            <X size={13} /> Clear
          </button>
        )}
        {query && (
          <span className="text-2xs font-mono text-neutral-500" role="status" aria-live="polite">
            {filtered.length} match{filtered.length === 1 ? '' : 'es'}
            {/* Says out loud what the search can and cannot reach, so nobody reads an empty
                result as "there is no such task" when it means "not one of yours". */}
            {!canViewTeamTasks
              ? ' in your tasks'
              : effectiveMineOnly
              ? ' in your tasks'
              : ' in what you can see'}
          </span>
        )}
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
          {canViewTeamTasks && employee?.id && (
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
          {canViewTeamTasks && (
            <div className="flex rounded-lg border border-neutral-200 dark:border-neutral-850 overflow-hidden">
              <ViewBtn active={view === 'flow'} onClick={() => setView('flow')} icon={GitBranch} label="Flow" />
              <ViewBtn active={view === 'people'} onClick={() => setView('people')} icon={Users} label="By Person" />
            </div>
          )}
        </div>
      </div>

      {/* A rejected status change or delete used to say nothing at all. Both mutations were written
          to throw a specific message when RLS matched no row — "your access may have changed, or
          the task was deleted" — and neither was ever rendered: the dropdown simply snapped back to
          the old status on the next refetch, and the deleted row stayed put. Leave and Expenses
          both show their mutation errors here; Tasks now does too. */}
      {(update.error || del.error) && (
        <div role="alert" className="flex items-start gap-2 text-xs text-red-600 dark:text-red-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{(update.error || del.error).message}</span>
        </div>
      )}

      {/* body */}
      {isLoading ? (
        <div className="flex justify-center py-16 text-[#0ea971]"><Loader2 size={24} className="animate-spin" /></div>
      ) : error && tasks.length === 0 ? (
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
        <div className="premium-card p-10 text-center text-xs text-neutral-500 space-y-1.5">
          {query ? (
            <>
              <p>
                Nothing matches <span className="font-semibold text-neutral-700 dark:text-neutral-300">“{query}”</span>
                {statusFilter !== 'All' ? <> in “{statusFilter}”</> : null}.
              </p>
              {/* The reason an expected task is missing is usually one of these two, not a typo. */}
              <p className="text-2xs">
                {statusFilter !== 'All' && <>Try <button type="button" onClick={() => setStatusFilter('All')} className="underline cursor-pointer">All</button> — the search only looks at the current status. </>}
                {effectiveMineOnly && canViewTeamTasks && <>“My tasks” is on, so only your own are being searched. </>}
                {!canViewTeamTasks && <>You can only search tasks assigned to you. </>}
                {WINDOW_NOTE}
              </p>
            </>
          ) : (
            <p>
              No tasks {statusFilter !== 'All' ? `in "${statusFilter}"` : ''} to show.
              {canCreate && ' Create one to get started.'}
            </p>
          )}
        </div>
      ) : effectiveView === 'flow' ? (
        <div className="space-y-3">
          <StaleWarning error={error} />
          {roots.map((t) => (
            <TaskTree key={t.id} task={t} childrenOf={childrenOf} depth={0} actions={actions} />
          ))}
        </div>
      ) : (
        <div className="space-y-5">
          <StaleWarning error={error} />
          {byPerson.map((g) => (
            // Keyed on the group, not on `g.assignee?.id ?? 'x'`: the assignee OBJECT is null for
            // anyone whose employees row this viewer cannot read, and every such person was handed
            // the same key 'x' — React then rendered one group where there were several.
            <div key={g.key} className="space-y-2.5">
              <div className="flex items-center gap-2 px-1">
                {/* The app's avatar tile (Directory, Administration). This was btnClass('primary'),
                    which dressed a non-interactive div as the page's primary BUTTON — black, 30px
                    tall, cursor-pointer — sitting directly under the real one. */}
                <div className="w-8 h-8 rounded-lg bg-neutral-100 dark:bg-charcoal-800 text-neutral-700 dark:text-[#10b981] flex items-center justify-center font-bold text-xs shrink-0 font-mono select-none">
                  {(g.assignee?.full_name || '?').split(' ').filter(Boolean).slice(0, 2).map((s) => s[0]).join('').toUpperCase()}
                </div>
                <span className={`font-bold text-sm ${g.assignee ? 'text-neutral-800 dark:text-slate-100' : 'text-neutral-500 italic'}`}>
                  {g.assignee?.full_name || ASSIGNEE_HIDDEN}
                </span>
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
          // Remounts the panel whenever it is pointed at a different task — see composerKey().
          key={composerKey(composer)}
          employees={employees}
          canAssignTo={canAssignTo}
          currentEmployeeId={employee?.id}
          task={composer.task ?? null}
          // Reassigning is a manage action, not an update one: tasks_update lets an assignee move
          // their own task's status, and they must not be able to hand it to somebody else.
          canReassign={composer.task ? rowCan.manage(composer.task) : true}
          parentId={composer.parentId}
          defaultAssignee={composer.defaultAssignee}
          parentTask={composer.parentId ? tasks.find((t) => t.id === composer.parentId) : null}
          busy={composer.task ? edit.isPending : create.isPending}
          error={(composer.task ? edit.error : create.error)?.message}
          onClose={() => { create.reset(); edit.reset(); setComposer(null); }}
          onSubmit={async (payload) => {
            try {
              if (composer.task) await edit.mutateAsync({ id: composer.task.id, ...payload });
              else await create.mutateAsync(payload);
              setComposer(null);
            } catch { /* shown in the panel */ }
          }}
        />
      )}

      {!isLoading && !(error && tasks.length === 0) && filtered.length > 0 && (
        <p className="px-1 text-2xs text-neutral-400">{WINDOW_NOTE}</p>
      )}

      {toDelete && (
        <ConfirmDialog
          title="Delete this task?"
          confirmLabel="Delete task"
          busy={del.isPending}
          error={del.error?.message}
          onCancel={() => { del.reset(); setToDelete(null); }}
          onConfirm={async () => {
            try { await del.mutateAsync(toDelete.id); setToDelete(null); } catch { /* shown in the dialog */ }
          }}
        >
          <p><span className="font-semibold">{toDelete.title}</span> will be removed for everyone. This cannot be undone.</p>
          {(childrenOf.get(toDelete.id) || []).length > 0 && (
            <p>
              Its {(childrenOf.get(toDelete.id) || []).length} sub-task
              {(childrenOf.get(toDelete.id) || []).length !== 1 ? 's' : ''} will not be deleted — they
              stay on the board as tasks of their own.
            </p>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}

/**
 * The list is still on screen but the last refresh failed.
 *
 * The query cache is persisted for 24 hours (main.jsx), so a dropped connection, an expired token
 * or a changed grant arrives with a perfectly good list already rendered. Replacing it with an
 * error card — which is what happened — threw away the only copy of the data the user had, on a
 * board people open on a phone in a branch with poor signal. Say it is stale instead.
 */
function StaleWarning({ error }) {
  if (!error) return null;
  return (
    <div role="status" className="flex items-start gap-2 px-1 text-2xs text-amber-700 dark:text-amber-300">
      <AlertTriangle size={13} className="mt-0.5 shrink-0" />
      <span>Showing the last tasks loaded — the latest refresh failed ({error.message}).</span>
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
        <div className="mt-2.5 space-y-2.5">
          {kids.map((k) => (
            <TaskTree key={k.id} task={k} childrenOf={childrenOf} depth={depth + 1} actions={actions} />
          ))}
        </div>
      )}
    </div>
  );
}

function TaskCard({ task, actions, subCount = 0, nested = false }) {
  const pm = priorityMeta(task.priority);
  const overdue = isOverdue(task, actions.today);
  return (
    <div className={`premium-card ${nested ? 'bg-neutral-50/60 dark:bg-neutral-950/30' : ''}`}>
      <div className="mobile-list-row flex items-start justify-between gap-3">
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
              <span className={`font-semibold ${task.assignee ? 'text-neutral-700 dark:text-neutral-300' : 'text-neutral-500 italic'}`}>
                {task.assignee?.full_name || ASSIGNEE_HIDDEN}
              </span>
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
          {actions.canUpdate(task) ? (
            <select
              value={task.status}
              onChange={(e) => actions.setStatus(task.id, e.target.value)}
              aria-label={`Status of ${task.title}`}
              // `status-pill` keeps the status colour in dark mode: index.css repaints every
              // <select> with !important, which flattened all five statuses to the same grey — and
              // only for the people who can change one. See the rule there.
              className={`status-pill text-2xs font-bold uppercase tracking-wide font-mono rounded-md px-2 py-1 border cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0ea971]/50 ${statusClass(task.status)}`}
            >
              {TASK_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          ) : (
            <span className={`text-2xs px-2 py-0.5 rounded-full font-mono font-bold uppercase tracking-wider border ${statusClass(task.status)}`}>
              {task.status}
            </span>
          )}
          <div className="flex items-center gap-1">
            {actions.canUpdate(task) && (
              <button onClick={() => actions.edit(task)} title="Edit task" aria-label={`Edit ${task.title}`}
                className="p-1.5 rounded-lg text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-white cursor-pointer">
                <PenLine size={13} />
              </button>
            )}
            {actions.canCreate(task) && (
              <button onClick={() => actions.addSubtask(task)} title="Add sub-task" aria-label={`Add a sub-task under ${task.title}`}
                className="p-1.5 rounded-lg text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-white cursor-pointer">
                <Plus size={13} />
              </button>
            )}
            {actions.canManage(task) && (
              <button onClick={() => actions.remove(task)} title="Delete task" aria-label={`Delete ${task.title}`}
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

function TaskComposer({
  employees, canAssignTo, currentEmployeeId, task, canReassign = true,
  parentId, defaultAssignee, parentTask, busy, error, onClose, onSubmit,
}) {
  const editing = Boolean(task);
  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [priority, setPriority] = useState(task?.priority ?? 'Medium');
  const [dueDate, setDueDate] = useState(task?.due_date ?? '');
  const [assigneeId, setAssigneeId] = useState(task?.employee_id ?? defaultAssignee ?? currentEmployeeId ?? '');
  const [q, setQ] = useState('');

  // Two lists, because the difference between them is worth saying out loud: `matches` is who the
  // text found, `results` is who of those this person may actually be given a task. Silently
  // showing nothing when a colleague exists but is out of scope reads as a broken search.
  const { results, outOfScope } = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return { results: [], outOfScope: 0 };
    const matches = employees.filter(
      (e) => (e.full_name || '').toLowerCase().includes(needle) || (e.employee_code || '').toLowerCase().includes(needle)
    );
    const allowed = canAssignTo ? matches.filter(canAssignTo) : matches;
    return { results: allowed.slice(0, 8), outOfScope: matches.length - allowed.length };
  }, [employees, q, canAssignTo]);

  const chosen = employees.find((e) => e.id === assigneeId);
  // An assignee the viewer cannot read at all — the embedded join was empty, so they are not in
  // `employees`. Editing must not silently drop them, so the field is shown as locked instead.
  const assigneeUnknown = Boolean(assigneeId) && !chosen;

  const submit = (e) => {
    e.preventDefault();
    if (!title.trim() || !assigneeId) return;
    const fields = {
      title: title.trim(),
      description: description.trim() || null,
      priority,
      due_date: dueDate || null,
      employee_id: assigneeId,
    };
    // An edit patches the task in place. `assigned_by` is deliberately left alone — it records who
    // delegated the work, not who last touched the row — and `status` is not sent, so the update
    // hook leaves completed_at where it is (it only rewrites it when a status is in the patch).
    onSubmit(editing ? fields : { ...fields, assigned_by: currentEmployeeId || null, parent_task_id: parentId || null });
  };

  return (
    <FormSection
      title={editing ? 'Edit task' : parentId ? 'New sub-task' : 'New task'}
      subtitle={editing ? 'Change the details, the deadline or who is carrying it.' : parentId ? undefined : 'Assign work to someone in your scope.'}
      icon={editing ? PenLine : parentId ? CornerDownRight : Plus}
      onClose={onClose}
      onSubmit={submit}
      submitLabel={editing ? 'Save changes' : parentId ? 'Add sub-task' : 'Create task'}
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
            {assigneeUnknown ? (
              <p className="rounded-xl bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 px-3 py-2 text-xs text-neutral-500 italic">
                {ASSIGNEE_HIDDEN} — it stays with them.
              </p>
            ) : !canReassign ? (
              // tasks_update lets an assignee move their own task's status; handing the work to
              // somebody else is a manage action, and the database would refuse it.
              <div className="rounded-xl bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 px-3 py-2 text-xs">
                <span className="font-semibold text-neutral-800 dark:text-neutral-200">{chosen?.full_name}</span>
                <span className="font-mono text-2xs text-neutral-500"> · {chosen?.employee_code}</span>
                <span className="block text-2xs text-neutral-400 mt-0.5">You can edit this task but not reassign it.</span>
              </div>
            ) : chosen ? (
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
                {q.trim() && results.length === 0 && (
                  <p className="mt-1 text-2xs text-neutral-500 flex items-start gap-1.5">
                    <ShieldAlert size={12} className="mt-0.5 shrink-0 text-amber-500" />
                    {outOfScope > 0
                      ? `${outOfScope} ${outOfScope === 1 ? 'person matches' : 'people match'}, but assigning work to them is outside your scope.`
                      : 'Nobody matches that name or code.'}
                  </p>
                )}
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
                {currentEmployeeId && (!canAssignTo || employees.some((e) => e.id === currentEmployeeId && canAssignTo(e))) && (
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
                {TASK_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
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
