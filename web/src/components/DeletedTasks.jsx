import React, { useDeferredValue, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, RotateCcw, Search } from 'lucide-react';
import { useDeletedTasks, useRestoreTask } from '../data/tasks';
import { assigneesOf, searchTasks } from '../lib/taskBoard';
import { humanDbError } from '../lib/dbErrors';
import Pagination, { usePagination } from './ui/Pagination';
import { TaskListSkeleton } from './TaskSkeletons';

const DATE = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
});
const EMPTY_ROWS = [];

// The server returns only manageable deleted tasks. The additional UI check respects the
// selected role lens, which can narrow a manager's session to their own employee view.
export default function DeletedTasks({ canRestore = () => false }) {
  const query = useDeletedTasks({ enabled: true });
  const restore = useRestoreTask();
  const [notice, setNotice] = useState('');
  const tasks = query.data ?? EMPTY_ROWS;
  const rows = useMemo(() => tasks.filter((task) => task.can_restore === true && canRestore(task)), [tasks, canRestore]);

  const onRestore = async (task) => {
    if (restore.isPending || task.can_restore !== true || !canRestore(task)) return;
    restore.reset();
    setNotice('');
    try {
      await restore.mutateAsync(task.id);
      setNotice(`“${task.title}” was restored with its saved status.`);
    } catch { /* The list keeps the task and shows the error so the action can be retried. */ }
  };

  return <DeletedTaskList rows={rows} loading={query.isLoading} loadError={query.error}
    onRetry={() => query.refetch()} busy={restore.isPending} restoringId={restore.variables}
    restoreError={restore.error} onRestore={onRestore} notice={notice} />;
}

export function DeletedTaskList({
  rows = EMPTY_ROWS, loading = false, loadError, onRetry,
  busy = false, restoringId, restoreError, onRestore, notice,
}) {
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const filtered = useMemo(() => searchTasks(rows, deferredSearch), [rows, deferredSearch]);
  const pager = usePagination(filtered, 10, null, deferredSearch);

  return <section className="space-y-4" aria-label="Deleted tasks">
    <div>
      <h2 className="text-base font-semibold">Deleted tasks</h2>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        Restore a task with its saved status, assignees, checklist, comments and attachments.
      </p>
    </div>
    <label className="work-search input-shell">
      <Search size={16} aria-hidden="true" />
      <input type="search" value={search} onChange={(event) => setSearch(event.target.value)}
        aria-label="Search deleted tasks" placeholder="Search deleted tasks…" />
    </label>
    {notice && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">{notice}</p>}
    {restoreError && <p role="alert" className="text-sm text-rose-600 dark:text-rose-300">{humanDbError(restoreError, 'tasks')}</p>}
    {loadError && <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
      <AlertTriangle size={16} aria-hidden="true" />
      <p>{rows.length ? 'The deleted task list may be out of date. ' : 'Could not load deleted tasks. '}{humanDbError(loadError, 'tasks')}</p>
      {onRetry && <button type="button" className="work-button" onClick={onRetry}>Try again</button>}
    </div>}
    {loading ? <TaskListSkeleton /> : filtered.length ? <>
      <div className="task-list-summary" aria-live="polite"><div>
        <strong>Showing {pager.from}–{pager.to} of {pager.count} deleted task{pager.count === 1 ? '' : 's'}</strong>
      </div></div>
      <div className="work-list" role="list" aria-label="Deleted task list">
        {pager.slice.map((task) => <DeletedTaskRow key={task.id} task={task} onRestore={onRestore}
          canRestore={task.can_restore === true} busy={busy} restoring={busy && restoringId === task.id} />)}
      </div>
      <Pagination {...pager} noun="deleted tasks" sizes={[10, 25, 50, 100]} keepVisible />
    </> : !loadError && <div className="work-empty">
      <strong>{search ? 'No deleted tasks match your search.' : 'No deleted tasks to restore.'}</strong>
      <p>{search ? 'Try another task title, person or branch.' : 'Tasks you delete will appear here when you have permission to restore them.'}</p>
    </div>}
  </section>;
}

export function DeletedTaskRow({ task, canRestore = false, busy = false, restoring = false, onRestore }) {
  const people = assigneesOf(task).map((person) => person.employee?.full_name || 'Assignee not visible');
  const deletedAt = task.deleted_at ? new Date(task.deleted_at) : null;
  const deletedLabel = deletedAt && !Number.isNaN(deletedAt.getTime()) ? DATE.format(deletedAt) : null;
  return <article className="work-row p-4 sm:p-5" role="listitem">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1 basis-56">
        <h3 className="text-base font-semibold break-words">{task.title}</h3>
        {task.description && <p className="work-description">{task.description}</p>}
        <div className="work-row-meta">
          <span>{people.join(', ') || 'Assignee not visible'}</span>
          <span>Saved status: {task.status}</span>
          {task.due_date && <span>Due {task.due_date.slice(0, 10)}</span>}
          {deletedLabel && <span>Deleted <time dateTime={task.deleted_at}>{deletedLabel}</time></span>}
          {task.deleted_task_count > 1 && <span>Restores {task.deleted_task_count} tasks together</span>}
        </div>
      </div>
      {canRestore && task.can_restore === true && <button type="button" className="work-button work-icon-button" disabled={busy}
        title={restoring ? 'Restoring…' : 'Restore task'} aria-label={restoring ? `Restoring ${task.title}` : `Restore ${task.title}`} onClick={() => {
          if (!busy) onRestore?.(task);
        }}>
        {restoring ? <Loader2 size={18} className="animate-spin" aria-hidden="true" /> : <RotateCcw size={18} aria-hidden="true" />}
      </button>}
    </div>
  </article>;
}
