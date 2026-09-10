// Personal work uses the same readable rows as the team list, with a self-assigned quick add.
import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Loader2, ChevronDown, ChevronRight, Search } from 'lucide-react';
import { useCreateTask, useUpdateTask, useDeleteTask } from '../data/tasks';
import { useTaskCommentCounts } from '../data/taskComments';
import { useTaskAttachmentCounts } from '../data/taskAttachments';
import { useAuth } from '../auth/AuthContext';
import { humanDbError } from '../lib/dbErrors';
import { istToday } from '../lib/dates';
import { TASK_PRIORITIES, searchTasks } from '../lib/taskBoard';
import { myBoard, progress, isSelfSet } from '../lib/todoPipeline';
import TaskListRow, { TaskListColumns } from './TaskListRow';
import TaskDetail from './TaskDetail';
import Pagination, { usePagination } from './ui/Pagination';
import ConfirmDialog from './ui/ConfirmDialog';

export default function TaskTodo({ tasks = [], loading, loadError, focusId, rowProps }) {
  const { employee } = useAuth();
  const me = employee?.id ?? null;
  const today = istToday();
  const create = useCreateTask();
  const update = useUpdateTask();
  const remove = useDeleteTask();
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState('Medium');
  const [due, setDue] = useState('');
  const [query, setQuery] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const [openDetail, setOpenDetail] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const board = useMemo(() => myBoard(tasks, me, { today }), [tasks, me, today]);
  const stats = useMemo(() => progress(tasks, me, { today }), [tasks, me, today]);
  // A notification must remain findable even when it points to finished work.
  const focusedClosed = board.closed.some((task) => task.id === focusId);
  const finishedVisible = showClosed || focusedClosed;
  useEffect(() => {
    if (focusedClosed) setShowClosed(true);
  }, [focusedClosed]);
  const openRows = useMemo(() => searchTasks(board.open, query), [board.open, query]);
  const closedRows = useMemo(() => searchTasks(board.closed, query), [board.closed, query]);
  const openPager = usePagination(openRows, 10, focusId);
  const closedPager = usePagination(closedRows, 10, focusId);
  const visibleIds = useMemo(() => [
    ...openPager.slice.map((task) => task.id),
    ...(finishedVisible ? closedPager.slice.map((task) => task.id) : []),
  ], [openPager.slice, closedPager.slice, finishedVisible]);
  const { data: commentCounts = {} } = useTaskCommentCounts(visibleIds);
  const { data: attachmentCounts = {} } = useTaskAttachmentCounts(visibleIds);
  const error = humanDbError(create.error || update.error || remove.error, 'tasks');

  if (!me) {
    return <div className="work-empty">Your login is not linked to an employee record yet. An administrator can link it in Administration → Users &amp; Access.</div>;
  }

  const add = async (event) => {
    event.preventDefault();
    if (!title.trim() || create.isPending) return;
    try {
      await create.mutateAsync({
        employee_id: me, assigned_by: me, title: title.trim(), priority, due_date: due || null,
      });
      setTitle('');
      setDue('');
      setPriority('Medium');
      setQuery('');
      openPager.setPage(1);
    } catch { /* shown below; keep the draft */ }
  };

  const actions = {
    today, rowProps, openDetail, commentCounts, attachmentCounts,
    toggleDetail: (id) => setOpenDetail((current) => current === id ? null : id),
    setStatus: (id, status) => update.mutate({ id, status }),
    busy: update.isPending,
    canUpdate: () => true, // myBoard only includes work assigned to this employee.
    canManage: (task) => isSelfSet(task, me),
    remove: (task) => { remove.reset(); setConfirmDelete(task); },
  };

  const renderList = (pager, label) => (
    <>
      <div className="task-list-summary" aria-live="polite">
        <div><span className="task-list-summary-label">{label}</span>
          <strong>Showing {pager.from}–{pager.to} of {pager.count} task{pager.count === 1 ? '' : 's'}</strong>
        </div>
      </div>
      <div className="work-list" role="list" aria-label={label}>
        <TaskListColumns />
        {pager.slice.map((task) => (
          <TaskListRow key={task.id} task={task} actions={actions}>
            <TaskDetail task={task} open={openDetail === task.id} />
          </TaskListRow>
        ))}
      </div>
      <Pagination {...pager} noun="tasks" sizes={[10, 25, 50, 100]} keepVisible />
    </>
  );

  return (
    <div className="work-personal">
      <section className="work-personal-summary" aria-label="My task progress">
        <div><strong>{stats.open} task{stats.open === 1 ? '' : 's'} to go</strong>
          <span>{stats.done} of {stats.total} completed{stats.overdue > 0 && <span className="work-overdue"> · {stats.overdue} overdue</span>}</span>
        </div>
        <div className="work-progress" role="progressbar" aria-valuenow={stats.percent} aria-valuemin={0} aria-valuemax={100} aria-label="My task completion">
          <span style={{ width: `${stats.percent}%` }} />
        </div>
      </section>

      <form onSubmit={add} className="work-quick-add">
        <label htmlFor="todo-title">Add a task for yourself</label>
        <div className="work-quick-fields">
          <input id="todo-title" value={title} onChange={(event) => setTitle(event.target.value)}
            placeholder="What needs to get done?" maxLength={200} disabled={create.isPending} required />
          <select aria-label="Priority for new task" value={priority} onChange={(event) => setPriority(event.target.value)} disabled={create.isPending}>
            {TASK_PRIORITIES.map((value) => <option key={value}>{value}</option>)}
          </select>
          <input aria-label="Due date for new task" type="date" value={due} onChange={(event) => setDue(event.target.value)} disabled={create.isPending} />
          <button type="submit" disabled={!title.trim() || create.isPending} className="work-button work-button-primary">
            {create.isPending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add task
          </button>
        </div>
      </form>
      {error && <p role="alert" className="text-sm text-rose-600 dark:text-rose-300">{error}</p>}
      {loadError && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">
        {tasks.length ? 'Your list may be out of date. ' : 'Could not load tasks. '}{humanDbError(loadError, 'tasks')}
      </p>}

      <label className="work-search">
        <Search size={16} />
        <input type="search" value={query} aria-label="Search my tasks" placeholder="Search my tasks…"
          onChange={(event) => { setQuery(event.target.value); openPager.setPage(1); closedPager.setPage(1); }} />
      </label>
      {loading ? <div className="work-empty" role="status"><Loader2 size={22} className="animate-spin" aria-label="Loading tasks" /></div>
        : !openRows.length ? <div className="work-empty">
          <strong>{query ? 'No active tasks match your search.' : loadError ? 'Your tasks could not be loaded.' : 'Your list is clear.'}</strong>
          <p>{query ? 'Try another search or check your finished tasks below.' : 'Add a task above. Tasks assigned by your team also appear here.'}</p>
        </div> : renderList(openPager, 'Active tasks')}

      {board.closed.length > 0 && (
        <section className="work-personal">
          <button type="button" className="work-finished-toggle" aria-expanded={finishedVisible}
            aria-controls="finished-tasks" onClick={() => setShowClosed((value) => !value)}>
            {finishedVisible ? <ChevronDown size={15} /> : <ChevronRight size={15} />} Finished <span>{board.closed.length}</span>
          </button>
          <div id="finished-tasks" className="work-personal" hidden={!finishedVisible}>
            {finishedVisible && (closedRows.length ? renderList(closedPager, 'Finished tasks') : <p className="work-empty">No finished tasks match your search.</p>)}
          </div>
        </section>
      )}
      {confirmDelete && (
        <ConfirmDialog title={`Delete “${confirmDelete.title}”?`} confirmLabel="Delete task" busy={remove.isPending} error={remove.error?.message}
          onCancel={() => { remove.reset(); setConfirmDelete(null); }}
          onConfirm={async () => {
            try { await remove.mutateAsync(confirmDelete.id); setConfirmDelete(null); }
            catch { /* shown in the dialog */ }
          }}>
          <p>This task and its subtasks will be removed for everyone assigned to it. This cannot be undone.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
