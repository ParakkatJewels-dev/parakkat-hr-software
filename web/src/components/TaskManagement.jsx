import React, { useState, useMemo, useEffect, useDeferredValue } from 'react';
import {
  ListChecks, Plus, X, Loader2, AlertTriangle, Flag,
  CalendarClock, User, Search, PenLine, ShieldAlert, HandHelping,
  CheckSquare, Square, ArrowDownWideNarrow,
} from 'lucide-react';
import {
  useTasks, useCreateTask, useUpdateTask, useDeleteTask, useAddAssignee, useRemoveAssignee,
  CLOSED_TASK_WINDOW_DAYS,
} from '../data/tasks';
import { useEmployees } from '../data/employees';
import { useAuth } from '../auth/AuthContext';
import FormSection from './ui/FormSection';
import ConfirmDialog from './ui/ConfirmDialog';
import { usePermissions } from '../auth/usePermissions';
import { useUrlTab } from '../lib/useUrlTab';
// A help request is a request for a TASK, so it lives here rather than beside the team roster:
// this is the screen people already open when they are thinking about work.
import TeamRequests from './TeamRequests';
import { useMyDepartments } from '../data/team';
import { useHelpRequests, useUpdateRequestedTask } from '../data/helpRequests';
import { pendingCount, outgoingRequests } from '../lib/helpRequests';
// The board's reasoning — filtering, counting, nesting, grouping — lives in lib so it can be
// tested. This file imports Supabase through its data hooks, which the test runner cannot load.
import {
  TASK_PRIORITIES,
  filterTasks, sortTasks, taskStats, composerKey, assigneesOf, assigneeIds,
} from '../lib/taskBoard';
import TaskListRow, { TaskListColumns } from './TaskListRow';
import './tasks.css';
import Pagination, { usePagination } from './ui/Pagination';
import { useFocusRow } from '../lib/useFocusRow';
import { focusIsMissing } from '../lib/focusRow';
import { humanDbError } from '../lib/dbErrors';
import TaskDetail from './TaskDetail';
import TaskRoutine from './TaskRoutine';
import TaskTodo from './TaskTodo';
import { useTaskCommentCounts } from '../data/taskComments';
import { useTaskAttachmentCounts } from '../data/taskAttachments';
import { istToday } from '../lib/dates';

const INPUT =
  'w-full text-sm rounded-xl px-3 py-2 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-[#5263c7] transition-colors';

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
const TASKS_PER_PAGE = 10;

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
  const addAssignee = useAddAssignee();
  const removeAssignee = useRemoveAssignee();

  // A task is assigned to someone (the assignee is picked in the composer), so — unlike leave —
  // the creator need NOT be linked to an employee themselves. Only the permission matters.
  const canCreate = canAny('task.create');
  const canViewTeamTasks = canBeyondSelf('task.read');
  // Asking another department, and answering when asked. Held by department heads and up (0101).
  const canUseRequests = canAny('task.request');

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
    // Editing WHAT the work is, which for a task you asked for is not the same as owning it.
    edit: (t) => can('task.update', scopeOf(t)) || can('task.manage', scopeOf(t)) || requestedTaskIds.has(t.id),
    manage: (t) => can('task.manage', scopeOf(t)),
    // A sub-task is filed against the same assignee, so it is the parent's ancestry that decides.
    create: (t) => can('task.create', scopeOf(t)),
  };

  // In the URL, so a refresh comes back to the view you were reading.
  //
  // 'flow' and 'people' were retired in 0114. tabFromPath falls back to the default for an id it
  // does not recognise, so an old link or a bookmarked ?tab=flow lands on the board rather than
  // rendering nothing — which is the whole reason that fallback exists.
  const [view, setView] = useUrlTab('board', ['board', 'todo', 'requests', 'routine']);
  const [statusFilter, setStatusFilter] = useState('Active'); // Active | All | Overdue | <status>
  const [mineOnly, setMineOnly] = useState(false);
  // What the By Person view used to answer — "who is carrying what" — as a narrowing of the one
  // board rather than a second way of drawing the same rows. '' is Everyone.
  const [personId, setPersonId] = useState('');
  const [composer, setComposer] = useState(null); // { defaultAssignee } | { task } | null
  const [toDelete, setToDelete] = useState(null); // the task awaiting confirmation
  const [query, setQuery] = useState('');
  const [sortOrder, setSortOrder] = useState('recommended');
  // Sent here by a notification. Unlike Leave and Expenses, this board does NOT default to "All" —
  // it opens on Active — so a completed task somebody was linked to would render nothing at all and
  // the link would look broken. Widen to All when the target is not in the current view.
  const { focusId, rowProps } = useFocusRow();
  // The box keeps up with typing; re-filtering and re-rendering the tree is allowed to lag a frame.
  const deferredQuery = useDeferredValue(query);
  const effectiveMineOnly = !canViewTeamTasks || mineOnly;
  // Everyone with a task.read gets the routine — an employee's own list is the point of it — so it
  // is not gated on seeing the team, unlike Flow and By Person.
  // 'todo' is everyone's, like the routine: it is the one view that is about your OWN plate, and
  // 0113 makes filing work on your own board need no permission at all. A plain employee lands
  // here rather than on a Flow board that only ever shows their own rows anyway.
  const effectiveView =
    view === 'requests' ? (canUseRequests ? 'requests' : 'board')
    : view === 'routine' ? 'routine'
    : view === 'todo' ? 'todo'
    : canViewTeamTasks ? 'board'
    : 'todo';
  const isBoard = effectiveView === 'board';

  // Only what is waiting on YOU. A request you raised is waiting on somebody else, and badging it
  // would read as work you owe. See pendingCount.
  const { data: myDepartments = [] } = useMyDepartments({ enabled: canUseRequests });
  const { data: helpRequests = [] } = useHelpRequests({ enabled: canUseRequests });
  const waitingOnMe = pendingCount(helpRequests, myDepartments.map((d) => d.id));

  /**
   * Tasks that exist because THIS person asked another department for them.
   *
   * They can see these (0101 widened tasks_select) and they are who wanted the work, but
   * tasks_update scopes by the assignee's ancestry — so the ordinary pencil belongs to the other
   * department alone. These get one through a narrow function that writes what the work IS and
   * never who is doing it (0104).
   */
  const requestedTaskIds = useMemo(() => new Set(
    outgoingRequests(helpRequests, myDepartments.map((d) => d.id))
      .filter((r) => r.task_id)
      .map((r) => r.task_id)
  ), [helpRequests, myDepartments]);
  const editRequested = useUpdateRequestedTask();
  const isRequestedByMe = (t) => requestedTaskIds.has(t.id) && !can('task.update', scopeOf(t));

  // One reading of "today" per render, in IST, shared by the filter, the counts and every badge —
  // so a board rendered across midnight cannot disagree with itself about what is late.
  const today = istToday();

  const myEmployeeId = employee?.id ?? null;
  const filtered = useMemo(
    () => sortTasks(
      filterTasks(tasks, { mineOnly: effectiveMineOnly, myEmployeeId, personId, statusFilter, query: deferredQuery, today }),
      today, sortOrder
    ),
    [tasks, effectiveMineOnly, myEmployeeId, personId, statusFilter, deferredQuery, today, sortOrder]
  );
  const stats = useMemo(
    () => taskStats(tasks, { mineOnly: effectiveMineOnly, myEmployeeId, personId, query: deferredQuery, today }),
    [tasks, effectiveMineOnly, myEmployeeId, personId, deferredQuery, today]
  );

  /**
   * The names in the "Everyone" dropdown: people who actually appear on the visible tasks.
   *
   * Not the whole directory. A filter offering fifty names that return nothing is worse than no
   * filter — this only ever lists somebody you could actually select your way to.
   */
  const peopleOnBoard = useMemo(() => {
    const seen = new Map();
    for (const t of tasks) {
      for (const row of assigneesOf(t)) {
        if (!row.id || seen.has(row.id)) continue;
        seen.set(row.id, row.employee?.full_name || (row.id === myEmployeeId ? 'Me' : ASSIGNEE_HIDDEN));
      }
    }
    return [...seen.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [tasks, myEmployeeId]);

  // A filter pinned to somebody who has dropped off the board entirely (their last task closed and
  // aged out) would show an empty list with no obvious way back. Clear it rather than strand them.
  useEffect(() => {
    if (personId && !peopleOnBoard.some((p) => p.id === personId)) setPersonId('');
  }, [personId, peopleOnBoard]);
  // A notification linked to a task the current filter hides — a completed one, most often, since
  // this board opens on Active. Widen once rather than showing an empty board under a link that
  // promised to take you somewhere.
  useEffect(() => {
    if (!focusId || statusFilter === 'All') return;
    const known = tasks.some((t) => t.id === focusId);
    if (known && !filtered.some((t) => t.id === focusId)) setStatusFilter('All');
  }, [focusId, statusFilter, tasks, filtered]);

  // Loaded, and still not here: RLS no longer returns it, or it was deleted. Say so — the one thing
  // worse than not linking to a row is linking to it and then showing a list without it.
  const focusMissing = focusIsMissing(focusId, tasks, { loaded: !isLoading });

  /**
   * The board was the only list in the app that rendered everything it had.
   *
   * Leave, Expenses and Helpdesk have paged at 25 since they were written. This used to page by
   * ROOT so that a parent and its sub-tasks were never split across a page; with the tree gone
   * there are no families to keep together, so it pages by task and the focus anchor is simply the
   * task a notification pointed at. Ten is intentional here: these cards show the complete task
   * instruction, not a one-line table row, so 25 makes each page unnecessarily long on a phone.
   */
  const pager = usePagination(filtered, TASKS_PER_PAGE, focusId);

  /**
   * Who this person may file a task against.
   *
   * Mirrors the tasks_insert policy, which checks task.create against the ASSIGNEE's ancestry. The
   * picker offered every employee the viewer could read, and those are different sets: a department
   * head can read their whole branch's directory but may only assign inside their department, so
   * choosing the wrong colleague produced a raw row-level-security error on submit with nothing to
   * explain it. Now they are not offered.
   */
  const scopeOfEmployee = (e) => ({
    entityId: e.entity_id, zoneId: e.zone_id, branchId: e.branch_id,
    deptId: e.department_id, employeeId: e.id,
  });

  /**
   * Who this person may file a NEW task against — tasks_insert checks task.create on the assignee.
   */
  const canAssignTo = (e) => can('task.create', scopeOfEmployee(e));

  /**
   * Who they may move an EXISTING task to.
   *
   * Not the same question, and asking the wrong one is what produced a raw
   * "new row violates row-level security policy for table tasks" on screen. tasks_update has a
   * WITH CHECK, so the row must still be yours AFTER the move — which is task.update/task.manage on
   * the NEW assignee, not task.create. They coincide for the seeded roles and come apart the moment
   * anyone defines a custom one; the picker should ask about the operation it is actually doing.
   */
  const canReassignTo = (e) =>
    can('task.update', scopeOfEmployee(e)) || can('task.manage', scopeOfEmployee(e));

  // Which task has its detail open. One at a time: two open threads on one board is a wall of text
  // where a list should be.
  const [openDetail, setOpenDetail] = useState(null);

  // Counts for the page on screen only, in two queries rather than two per card.
  const visibleIds = useMemo(
    () => (isBoard ? pager.slice.map((t) => t.id) : []),
    [isBoard, pager.slice]
  );
  const { data: commentCounts = {} } = useTaskCommentCounts(visibleIds);
  const { data: attachmentCounts = {} } = useTaskAttachmentCounts(visibleIds);

  /**
   * Bring a task's assignee list in line with what the composer was left showing.
   *
   * An edit patches the task row, but the people on it live in their own table, so the two have to
   * be reconciled by hand. Removals go first: if somebody is being swapped for somebody else, doing
   * the add first would briefly leave the task with both, and the notification the new person gets
   * would be the only trace of an intermediate state that never really existed.
   *
   * The primary is skipped in both directions — `edit` has already moved tasks.employee_id, and the
   * junction row for whoever now holds it is added here if it is missing.
   */
  const syncAssignees = async (task, wanted) => {
    const had = assigneeIds(task);
    const keep = new Set(wanted);

    for (const id of had) {
      if (keep.has(id)) continue;
      await removeAssignee.mutateAsync({ taskId: task.id, employeeId: id, primaryId: wanted[0] });
    }
    for (const id of wanted) {
      if (had.includes(id)) continue;
      await addAssignee.mutateAsync({ taskId: task.id, employeeId: id, addedBy: employee?.id ?? null });
    }
  };

  const actions = {
    today,
    rowProps,
    openDetail,
    toggleDetail: (id) => setOpenDetail((cur) => (cur === id ? null : id)),
    commentCounts,
    attachmentCounts,
    setStatus: (id, status) => update.mutate({ id, status }),
    busy: update.isPending,
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
    canEdit: rowCan.edit,
    canManage: rowCan.manage,
    canCreate: rowCan.create,
  };

  return (
    <div className="task-management-page work-page">
      <header className="work-page-header">
        <div>
          <div className="work-eyebrow">Workspace / Tasks</div>
          <h1>{canViewTeamTasks ? 'Tasks' : 'My tasks'}</h1>
          <p>Everything to do. One place to move it forward.</p>
        </div>
        {canCreate && isBoard && (
          <button type="button" onClick={() => setComposer({ defaultAssignee: employee?.id })} className="work-button work-button-primary"><Plus size={16} /> New task</button>
        )}
      </header>
      <nav className="work-view-tabs" aria-label="Task views">
        {canViewTeamTasks && <ViewBtn active={isBoard} onClick={() => setView('board')} icon={ListChecks} label="Team tasks" />}
        <ViewBtn active={effectiveView === 'todo'} onClick={() => setView('todo')} icon={User} label="My tasks" />
        {canUseRequests && <ViewBtn active={effectiveView === 'requests'} onClick={() => setView('requests')} icon={HandHelping} label="Requests" badge={waitingOnMe} />}
        <ViewBtn active={effectiveView === 'routine'} onClick={() => setView('routine')} icon={CheckSquare} label="Routine" />
      </nav>
      {isBoard && <>
        <div className="work-overview" aria-label="Task summary">
          <Stat label="All tasks" value={stats.total} active={statusFilter === 'All'} onClick={() => { setStatusFilter('All'); pager.setPage(1); }} />
          <Stat label="To do" value={stats.todo} active={statusFilter === 'To Do'} onClick={() => { setStatusFilter('To Do'); pager.setPage(1); }} />
          <Stat label="In progress" value={stats.progress} active={statusFilter === 'In Progress'} onClick={() => { setStatusFilter('In Progress'); pager.setPage(1); }} />
          <Stat label="Completed" value={stats.done} active={statusFilter === 'Done'} onClick={() => { setStatusFilter('Done'); pager.setPage(1); }} />
          <Stat label="Overdue" value={stats.overdue} accent={stats.overdue > 0} active={statusFilter === 'Overdue'} onClick={() => { setStatusFilter('Overdue'); pager.setPage(1); }} />
        </div>
        <div className="work-toolbar">
          <label className="work-search">
            <Search size={16} />
            <input type="search" value={query} onChange={(e) => { setQuery(e.target.value); pager.setPage(1); }}
              aria-label="Search tasks" placeholder="Search tasks, people or branches…" />
          </label>
          <div className="work-filters">
            <label className="work-filter"><span>Status</span>
              <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); pager.setPage(1); }} aria-label="Filter tasks by status">
                {['Active', 'All', 'To Do', 'In Progress', 'Blocked', 'Done', 'Cancelled', 'Overdue'].map((s) => <option key={s} value={s}>{s === 'All' ? 'All statuses' : s}</option>)}
              </select>
            </label>
            {peopleOnBoard.length > 1 && <label className="work-filter"><span>Assignee</span>
              <select value={personId} onChange={(e) => { setPersonId(e.target.value); pager.setPage(1); }} aria-label="Filter tasks by person">
                <option value="">Everyone</option>
                {peopleOnBoard.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>}
            <label className="work-filter"><ArrowDownWideNarrow size={14} /><span className="sr-only">Sort</span>
              <select value={sortOrder} onChange={(e) => { setSortOrder(e.target.value); pager.setPage(1); }} aria-label="Sort tasks">
                <option value="recommended">Recommended</option><option value="due">Due date</option><option value="priority">Priority</option><option value="newest">Newest first</option><option value="title">Title A–Z</option>
              </select>
            </label>
            {employee?.id && <button type="button" className="work-button work-mine" aria-pressed={mineOnly} onClick={() => { setMineOnly((v) => !v); pager.setPage(1); }}><User size={14} />Assigned to me</button>}
            {(query || personId || mineOnly || statusFilter !== 'Active') && <button type="button" className="work-button" onClick={() => { setQuery(''); setPersonId(''); setMineOnly(false); setStatusFilter('Active'); pager.setPage(1); }}><X size={13} />Clear filters</button>}
          </div>
        </div>
      </>}

      {/* A rejected status change or delete used to say nothing at all. Both mutations were written
          to throw a specific message when RLS matched no row — "your access may have changed, or
          the task was deleted" — and neither was ever rendered: the dropdown simply snapped back to
          the old status on the next refetch, and the deleted row stayed put. Leave and Expenses
          both show their mutation errors here; Tasks now does too. */}
      {isBoard && focusMissing && (
        <div role="status" className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>That task is no longer on your board — it may have been deleted, or reassigned outside what you can see.</span>
        </div>
      )}

      {isBoard && (update.error || del.error) && (
        <div role="alert" className="flex items-start gap-2 text-xs text-red-600 dark:text-red-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{humanDbError(update.error || del.error, 'tasks')}</span>
        </div>
      )}

      {/* The form sits ABOVE the list it adds to.
          It used to render after it, which reads fine on a screen with six rows and badly on
          one with two hundred: you press New Task at the top and the panel opens somewhere
          below the fold. FormSection scrolls itself into view, which hid the problem without
          fixing it — you still lose your place in the list you were reading. */}
      {isBoard && composer && (
        <TaskComposer
          // Remounts the panel whenever it is pointed at a different task — see composerKey().
          key={composerKey(composer)}
          employees={employees}
          canAssignTo={composer.task ? canReassignTo : canAssignTo}
          currentEmployeeId={employee?.id}
          task={composer.task ?? null}
          // Reassigning is a manage action, not an update one: tasks_update lets an assignee move
          // their own task's status, and they must not be able to hand it to somebody else.
          canReassign={composer.task ? (rowCan.manage(composer.task) && !isRequestedByMe(composer.task)) : true}
          defaultAssignee={composer.defaultAssignee}
          busy={composer.task ? (edit.isPending || editRequested.isPending) : create.isPending}
          error={humanDbError(
            composer.task ? (isRequestedByMe(composer.task) ? editRequested.error : edit.error) : create.error,
            'tasks'
          )}
          onClose={() => { create.reset(); edit.reset(); editRequested.reset(); setComposer(null); }}
          onSubmit={async (payload) => {
            try {
              if (composer.task && isRequestedByMe(composer.task)) {
                // A task another department is doing for me: change what it is, never who holds it.
                await editRequested.mutateAsync({
                  taskId: composer.task.id,
                  title: payload.title,
                  description: payload.description,
                  priority: payload.priority,
                  dueDate: payload.due_date,
                  clearDue: !payload.due_date,
                });
              } else if (composer.task) {
                const { assigneeIds: wanted = [], ...fields } = payload;
                await edit.mutateAsync({ id: composer.task.id, ...fields });
                await syncAssignees(composer.task, wanted);
              } else {
                await create.mutateAsync(payload);
              }
              setComposer(null);
            } catch { /* shown in the panel */ }
          }}
        />
      )}

      {/* body */}
      {effectiveView === 'requests' ? (
        <TeamRequests myDepartments={myDepartments} />
      ) : effectiveView === 'todo' ? (
        <TaskTodo tasks={tasks} loading={isLoading} loadError={error} focusId={focusId} rowProps={rowProps} />
      ) : effectiveView === 'routine' ? (
        <TaskRoutine employees={employees} />
      ) : isLoading ? (
        <div className="flex justify-center py-16 text-[#5263c7]"><Loader2 size={24} className="animate-spin" /></div>
      ) : error && tasks.length === 0 ? (
        <div className="premium-card p-5 flex items-start gap-3 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Couldn't load tasks.</p>
            <p className="text-neutral-500 dark:text-neutral-400 mt-1">
              {error.message}. For a missing task table, apply <code>0017_tasks.sql</code>; for missing
              assignees or checklists, apply <code>0114_many_hands_and_a_list.sql</code>.
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
      ) : (
        <div className="space-y-3">
          <StaleWarning error={error} />
          <div className="task-list-summary" aria-live="polite">
            <div>
              <span className="task-list-summary-label">Task list</span>
              <strong>
                Showing {pager.from}–{pager.to} of {pager.count} task{pager.count === 1 ? '' : 's'}
              </strong>
            </div>
            {pager.totalPages > 1 && (
              <span>Page {pager.page} of {pager.totalPages}</span>
            )}
          </div>
          <div className="work-list" role="list" aria-label="Tasks">
            <TaskListColumns />
            {pager.slice.map((t) => (
              <TaskListRow key={t.id} task={t} actions={actions}>
                <TaskDetail task={t} open={actions.openDetail === t.id} />
              </TaskListRow>
            ))}
          </div>
          <Pagination {...pager} noun="tasks" sizes={[10, 25, 50, 100]} className="task-list-pagination" keepVisible />
        </div>
      )}


      {isBoard && !isLoading && !(error && tasks.length === 0) && filtered.length > 0 && (
        <p className="px-1 text-2xs text-neutral-400">{WINDOW_NOTE}</p>
      )}

      {isBoard && toDelete && (
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
          <p>Its checklist goes with it, and everybody on the task loses it from their list.</p>
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

function TaskComposer({
  employees, canAssignTo, currentEmployeeId, task, canReassign = true,
  defaultAssignee, busy, error, onClose, onSubmit,
}) {
  const editing = Boolean(task);
  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [priority, setPriority] = useState(task?.priority ?? 'Medium');
  const [dueDate, setDueDate] = useState(task?.due_date ?? '');
  const [q, setQ] = useState('');

  /*
   * The steps, written on the same form as the task.
   *
   * They used to be reachable only after the task existed — create it, find it on the board, expand
   * it, then type the list — which is three navigations away from the moment somebody is actually
   * thinking about what the work is made of. Nobody did it.
   *
   * Local state, saved with the task in one action. Editing an EXISTING task's list stays on the
   * task itself, where ticking happens: two places to edit one list would be two places for it to
   * disagree with itself.
   */
  const [steps, setSteps] = useState([]);
  const [stepDraft, setStepDraft] = useState('');

  const addStep = () => {
    const clean = stepDraft.trim();
    if (!clean) return;
    setSteps((cur) => (cur.length >= 50 ? cur : [...cur, clean.slice(0, 200)]));
    setStepDraft('');
  };

  /**
   * Everybody on this task, in order, and the FIRST one is the primary.
   *
   * One array rather than "the assignee" plus "the others", because the difference between them is
   * not something the person filling this in should have to think about. It matters underneath:
   * position 0 becomes tasks.employee_id, which is what trg_tasks_ancestry stamps the branch and
   * department from, and therefore which managers can see the task at all. So the order is
   * meaningful and the UI says which one is carrying that weight — it just does not ask twice.
   */
  const [chosenIds, setChosenIds] = useState(() => {
    const existing = editing ? assigneeIds(task) : [];
    if (existing.length > 0) return existing;
    const seed = task?.employee_id ?? defaultAssignee ?? currentEmployeeId ?? '';
    return seed ? [seed] : [];
  });
  const assigneeId = chosenIds[0] ?? '';

  const addPerson = (id) => {
    setChosenIds((cur) => (cur.includes(id) ? cur : [...cur, id]));
    setQ('');
  };
  // Removing position 0 promotes the next person rather than leaving the task unscoped: employee_id
  // is NOT NULL, so there has to be a primary at all times.
  const removePerson = (id) => setChosenIds((cur) => cur.filter((x) => x !== id));

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
    //
    // assigneeIds rides alongside in both modes: on create the hook writes the junction rows, on
    // edit the caller diffs them against what the task already has.
    onSubmit(
      editing
        ? { ...fields, assigneeIds: chosenIds }
        : {
            ...fields,
            assigneeIds: chosenIds,
            // A step half-typed and never added is still what the person meant to include, so it
            // is taken along rather than silently dropped when they press Create instead of +.
            checklist: stepDraft.trim() ? [...steps, stepDraft.trim()] : steps,
            assigned_by: currentEmployeeId || null,
            parent_task_id: null,
          }
    );
  };

  return (
    <FormSection
      title={editing ? 'Edit task' : 'New task'}
      subtitle={editing ? 'Change the details, the deadline or who is on it.' : 'Assign work to people in your scope.'}
      icon={editing ? PenLine : Plus}
      onClose={onClose}
      onSubmit={submit}
      submitLabel={editing ? 'Save changes' : 'Create task'}
      busy={busy}
      disabled={!title.trim() || !assigneeId}
      error={error}
    >
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
            <label className="block text-base font-semibold text-neutral-600 dark:text-neutral-300">
              Assign to
            </label>

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
                <span className="block text-2xs text-neutral-400 mt-0.5">You can edit this task but not change who is on it.</span>
              </div>
            ) : (
              <>
                {chosenIds.length > 0 && (
                  <div className="task-assignee-chips flex flex-wrap gap-1.5 mb-2">
                    {chosenIds.map((id, index) => {
                      const person = employees.find((e) => e.id === id);
                      return (
                        <span
                          key={id}
                          className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-2xs ${
                            index === 0
                              ? 'border-[#5263c7]/30 bg-[#5263c7]/10 text-[#4251ad] dark:text-[#a5b4fc]'
                              : 'border-neutral-200 dark:border-neutral-850 bg-neutral-50 dark:bg-neutral-950 text-neutral-700 dark:text-neutral-300'
                          }`}
                        >
                          <span className="font-semibold">{person?.full_name ?? ASSIGNEE_HIDDEN}</span>
                          {person?.employee_code && (
                            <span className="font-mono opacity-70">{person.employee_code}</span>
                          )}
                          {id === currentEmployeeId && <span className="opacity-80">(me)</span>}
                          {/* Position 0 wears the task's branch and department, which is what
                              decides who else can see it. Worth one word rather than a surprise. */}
                          {index === 0 && <span className="font-bold uppercase tracking-wide opacity-70">main</span>}
                          <button
                            type="button"
                            onClick={() => removePerson(id)}
                            aria-label={`Remove ${person?.full_name ?? 'this person'} from the task`}
                            className="text-current opacity-50 hover:opacity-100 cursor-pointer"
                          >
                            <X size={11} />
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}

                <input
                  className={INPUT}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={chosenIds.length > 0 ? 'Add someone else…' : 'Search employee by name or code…'}
                />
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
                    {results.filter((e) => !chosenIds.includes(e.id)).map((e) => (
                      <button key={e.id} type="button" onClick={() => addPerson(e.id)}
                        className="w-full text-left px-3 py-2 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-900 flex justify-between items-center cursor-pointer">
                        <span className="font-semibold text-neutral-800 dark:text-neutral-200">{e.full_name}</span>
                        <span className="font-mono text-2xs text-neutral-500">{e.employee_code}{e.branch?.code ? ` · ${e.branch.code}` : ''}</span>
                      </button>
                    ))}
                  </div>
                )}
                {currentEmployeeId && !chosenIds.includes(currentEmployeeId)
                  && (!canAssignTo || employees.some((e) => e.id === currentEmployeeId && canAssignTo(e))) && (
                  <button type="button" onClick={() => addPerson(currentEmployeeId)} className="text-xs text-[#4251ad] dark:text-[#a5b4fc] hover:underline cursor-pointer mt-1">
                    Add myself
                  </button>
                )}
                {chosenIds.length === 0 && (
                  <p className="mt-1 text-2xs text-neutral-500">Pick at least one person. The first one is the main assignee.</p>
                )}
              </>
            )}
          </div>

          {/* The steps. Between the people and the deadline, because "who does it" and "what is it
              made of" are the same thought and the dates are an afterthought to both. */}
          <div className="space-y-1">
            <label className="block text-base font-semibold text-neutral-600 dark:text-neutral-300">
              Subtasks
              {steps.length > 0 && (
                <span className="ml-1.5 font-mono text-2xs font-normal text-neutral-400">{steps.length}</span>
              )}
            </label>

            {editing ? (
              // Editing an existing list stays on the task, where ticking happens. Two editors for
              // one list is two places for it to disagree with itself.
              <p className="rounded-xl bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 px-3 py-2 text-2xs text-neutral-500">
                Open the task on the board to tick its subtasks off or change them.
              </p>
            ) : (
              <>
                {steps.length > 0 && (
                  <ul className="space-y-1 mb-1.5">
                    {steps.map((step, index) => (
                      <li key={`${step}-${index}`} className="flex items-start gap-2 rounded-lg bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 px-2.5 py-1.5">
                        <Square size={13} className="mt-0.5 shrink-0 text-neutral-400" />
                        <span className="min-w-0 flex-1 text-xs text-neutral-800 dark:text-neutral-200 break-words">{step}</span>
                        <button
                          type="button"
                          onClick={() => setSteps((cur) => cur.filter((_, i) => i !== index))}
                          aria-label={`Remove subtask "${step}"`}
                          className="shrink-0 mt-0.5 text-neutral-300 dark:text-neutral-600 hover:text-rose-500 transition-colors cursor-pointer"
                        >
                          <X size={12} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {/* The + sits INSIDE the field and arrives with the text. A button that is
                    permanently there but greyed out reads as broken; one that appears the moment
                    there is something to add reads as the thing to press next. Enter does the same,
                    so the mouse is never the only way in. */}
                <div className="relative">
                  <input
                    className={INPUT + ' pr-10'}
                    value={stepDraft}
                    onChange={(e) => setStepDraft(e.target.value)}
                    onKeyDown={(e) => {
                      // Enter adds a subtask. Without this it submits the whole form, so writing a
                      // five-line list the obvious way would file five one-line tasks.
                      if (e.key === 'Enter') { e.preventDefault(); addStep(); }
                    }}
                    placeholder={steps.length > 0 ? 'Add another subtask…' : 'Type a subtask, then press +'}
                    maxLength={200}
                  />
                  {stepDraft.trim() && steps.length < 50 && (
                    <button
                      type="button"
                      onClick={addStep}
                      aria-label={`Add subtask "${stepDraft.trim()}"`}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 h-7 w-7 grid place-items-center rounded-lg bg-[#5263c7] text-white hover:bg-[#4251ad] transition-colors cursor-pointer animate-fade-in"
                    >
                      <Plus size={14} />
                    </button>
                  )}
                </div>

                <p className="text-2xs text-neutral-400 mt-1">
                  {steps.length >= 50
                    ? 'That is fifty subtasks — it is probably two tasks by now.'
                    : steps.length > 0
                    ? 'Anyone assigned can tick these off. When the last one is ticked, the task closes itself.'
                    : 'Leave it empty for a task that is one thing, and mark it done yourself.'}
                </p>
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

function ViewBtn({ active, onClick, icon: Icon, label, badge = 0 }) {
  return (
    <button type="button" onClick={onClick} aria-current={active ? 'page' : undefined} className="work-view-tab">
      <Icon size={15} /> {label}
      {badge > 0 && <span className="work-tab-count" aria-label={`${badge} waiting for you`}>{badge}</span>}
    </button>
  );
}

function Stat({ label, value, accent, onClick, active = false }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className={`work-stat ${accent ? 'work-stat-overdue' : ''}`}>
      <span className="work-stat-value">{value}</span><span>{label}</span>
    </button>
  );
}
