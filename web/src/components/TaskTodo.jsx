// My list.
//
// The team board answers "what is outstanding across my people". This answers the smaller and far
// more frequent question — what is on MY plate, and what moves next. People were using the team
// board for it and getting the wrong shape: grouped by person when there is only one person, led
// by a delegation tree when nothing here is delegated, and with a New Task form that asks who to
// assign it to when the answer is always the same.
//
// Anyone can use it. Filing work on your own board needs no permission (0113) — the assignee
// picker used to offer your own name and the database then refused the insert, because task.create
// stops at dept_head and nobody had noticed that it also stopped you writing down your own to-do.
//
// One tap moves an item along. The pipeline is To Do -> In Progress -> Done, with Blocked as a
// state you leave rather than a stage you pass through, so its button says Unblock.
import React, { useMemo, useState } from 'react';
import {
  ListTodo, Plus, Loader2, AlertTriangle, CalendarClock, Trash2, Flag, Check, Play, RotateCcw,
  ChevronDown, ChevronRight,
} from 'lucide-react';
import { useCreateTask, useUpdateTask, useDeleteTask } from '../data/tasks';
import { useAuth } from '../auth/AuthContext';
import { humanDbError } from '../lib/dbErrors';
import { istToday } from '../lib/dates';
import { isOverdue, TASK_PRIORITIES } from '../lib/taskBoard';
import {
  PIPELINE, myBoard, progress, nextStage, advanceLabel, isSelfSet,
} from '../lib/todoPipeline';
import { btnClass } from './ui/Btn';
import Pagination, { usePagination } from './ui/Pagination';
import ConfirmDialog from './ui/ConfirmDialog';

const INPUT =
  'w-full text-sm rounded-xl px-3 py-2 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 ' +
  'dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-[#0ea971] transition-colors';

const STAGE_TONE = {
  'To Do': 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
  'In Progress': 'bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300',
  Blocked: 'bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-300',
  Done: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
};

const ADVANCE_ICON = { 'To Do': Play, 'In Progress': Check, Blocked: RotateCcw };

export default function TaskTodo({ tasks = [], loading }) {
  const { employee } = useAuth();
  const me = employee?.id ?? null;
  const today = istToday();

  const create = useCreateTask();
  const update = useUpdateTask();
  const remove = useDeleteTask();

  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState('Medium');
  const [due, setDue] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const board = useMemo(() => myBoard(tasks, me, { today }), [tasks, me, today]);
  const stats = useMemo(() => progress(tasks, me, { today }), [tasks, me, today]);

  const openPager = usePagination(board.open, 10);
  const closedPager = usePagination(board.closed, 10);

  const error = humanDbError(create.error || update.error || remove.error, 'tasks');

  if (!me) {
    return (
      <div className="premium-card p-8 text-center text-sm text-neutral-500 max-w-prose mx-auto">
        Your login is not linked to an employee record yet, so there is no board to put anything on.
        An administrator can link it in Administration → Users &amp; Access.
      </div>
    );
  }

  const add = async (e) => {
    e.preventDefault();
    const text = title.trim();
    if (!text || create.isPending) return;
    try {
      // assigned_by is me as well: that is what makes it mine to delete later (0113).
      await create.mutateAsync({
        employee_id: me,
        assigned_by: me,
        title: text,
        priority,
        due_date: due || null,
      });
      setTitle('');
      setDue('');
      setPriority('Medium');
    } catch { /* shown below */ }
  };

  return (
    <div className="space-y-4">
      {/* ---- how far along the whole board is ---- */}
      <section className="premium-card space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 flex items-center gap-1.5">
            <ListTodo size={13} className="text-[#0ea971]" /> My list
          </h2>
          <span className="font-mono text-xs text-neutral-500">
            <span className="font-bold text-neutral-900 dark:text-white">{stats.done}</span> of {stats.total} done
            {stats.overdue > 0 && (
              <span className="text-rose-600 dark:text-rose-400 font-bold"> · {stats.overdue} overdue</span>
            )}
          </span>
        </div>

        <div
          className="h-2 rounded-full bg-neutral-150 dark:bg-neutral-850 overflow-hidden"
          role="progressbar" aria-valuenow={stats.percent} aria-valuemin={0} aria-valuemax={100}
          aria-label={`${stats.percent}% of your list is done`}
        >
          <div
            className="h-full bg-[#0a7d53] dark:bg-[#10b981] transition-[width] duration-500"
            style={{ width: `${stats.percent}%` }}
          />
        </div>

        {/* The stages, as counts. A row rather than columns: a Kanban board on a 360px screen is
            four columns nobody can read, and this is a list people open on the floor. */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
          {PIPELINE.map((stage) => (
            <div key={stage} className={`rounded-lg px-2.5 py-1.5 ${STAGE_TONE[stage]}`}>
              <div className="font-mono font-bold text-sm">{stats.byStage[stage]}</div>
              <div className="text-2xs font-semibold">{stage}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ---- add something ---- */}
      <form onSubmit={add} className="premium-card space-y-2.5">
        <label htmlFor="todo-title" className="block text-2xs font-bold uppercase tracking-widest text-neutral-450 dark:text-neutral-500">
          Add to my list
        </label>
        <input
          id="todo-title" value={title} onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs doing?" className={INPUT} maxLength={200}
        />
        <div className="flex flex-col sm:flex-row gap-2">
          <label className="sr-only" htmlFor="todo-priority">Priority</label>
          <select id="todo-priority" value={priority} onChange={(e) => setPriority(e.target.value)} className={INPUT + ' sm:w-32'}>
            {TASK_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <label className="sr-only" htmlFor="todo-due">Due date</label>
          <input id="todo-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} className={INPUT + ' sm:flex-1'} />
          <button type="submit" disabled={!title.trim() || create.isPending} className={btnClass('primary') + ' sm:w-auto'}>
            {create.isPending ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Add
          </button>
        </div>
        {error && (
          <p role="alert" className="text-xs text-red-600 dark:text-red-300">{error}</p>
        )}
      </form>

      {/* ---- what is live ---- */}
      {loading ? (
        <div className="flex justify-center py-12 text-[#0ea971]"><Loader2 size={20} className="animate-spin" /></div>
      ) : board.open.length === 0 ? (
        <div className="premium-card p-8 text-center text-sm text-neutral-500 space-y-1">
          <p className="font-semibold text-neutral-700 dark:text-neutral-300">Nothing on your list.</p>
          <p className="text-xs">Add the thing you keep meaning to do.</p>
        </div>
      ) : (
        <>
          <ul className="space-y-2">
            {openPager.slice.map((task) => (
              <TodoRow
                key={task.id}
                task={task}
                today={today}
                mine={me}
                busy={update.isPending}
                onAdvance={() => {
                  const next = nextStage(task.status);
                  if (next) update.mutate({ id: task.id, status: next });
                }}
                onBlock={() => update.mutate({ id: task.id, status: 'Blocked' })}
                onDelete={() => setConfirmDelete(task)}
              />
            ))}
          </ul>
          <Pagination {...openPager} noun="items" />
        </>
      )}

      {/* ---- what is finished, folded away ---- */}
      {board.closed.length > 0 && (
        <section className="space-y-2">
          <button
            type="button"
            onClick={() => setShowClosed((v) => !v)}
            aria-expanded={showClosed}
            className="flex items-center gap-1.5 text-2xs font-bold uppercase tracking-widest text-neutral-450 dark:text-neutral-500 hover:text-neutral-900 dark:hover:text-white cursor-pointer py-1"
          >
            {showClosed ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Finished <span className="font-mono opacity-70">{board.closed.length}</span>
          </button>
          {showClosed && (
            <>
              <ul className="space-y-2">
                {closedPager.slice.map((task) => (
                  <TodoRow
                    key={task.id} task={task} today={today} mine={me} busy={update.isPending}
                    onReopen={() => update.mutate({ id: task.id, status: 'To Do' })}
                    onDelete={() => setConfirmDelete(task)}
                  />
                ))}
              </ul>
              <Pagination {...closedPager} noun="items" />
            </>
          )}
        </section>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={`Remove "${confirmDelete.title}"?`}
          confirmLabel="Remove"
          busy={remove.isPending}
          error={remove.error?.message}
          onCancel={() => { remove.reset(); setConfirmDelete(null); }}
          onConfirm={async () => {
            try { await remove.mutateAsync(confirmDelete.id); setConfirmDelete(null); }
            catch { /* shown in the dialog */ }
          }}
        >
          <p>This takes it off your list for good. Nobody else sees it go.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/** One item: what it is, when it is due, and the one move that makes sense next. */
function TodoRow({ task, today, mine, busy, onAdvance, onBlock, onReopen, onDelete }) {
  const overdue = isOverdue(task, today);
  const label = advanceLabel(task.status);
  const Icon = ADVANCE_ICON[task.status];
  const done = task.status === 'Done';
  const cancelled = task.status === 'Cancelled';

  return (
    <li className="premium-card">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`font-bold text-sm min-w-0 line-clamp-2 ${
              done || cancelled ? 'text-neutral-400 line-through' : 'text-neutral-850 dark:text-slate-100'
            }`}>
              {task.title}
            </span>
            <span className={`text-2xs font-bold px-1.5 py-0.5 rounded shrink-0 ${STAGE_TONE[task.status] ?? 'bg-neutral-100 text-neutral-500 dark:bg-neutral-900'}`}>
              {task.status}
            </span>
          </div>
          <div className="flex items-center gap-2.5 flex-wrap text-2xs text-neutral-500 dark:text-neutral-400">
            <span className="inline-flex items-center gap-1 font-mono"><Flag size={10} /> {task.priority}</span>
            {task.due_date && (
              <span className={`inline-flex items-center gap-1 font-mono ${overdue && !done ? 'text-rose-600 dark:text-rose-400 font-bold' : ''}`}>
                <CalendarClock size={10} /> {task.due_date}{overdue && !done ? ' · overdue' : ''}
              </span>
            )}
            {/* Says where it came from, because a job your head gave you is not one you can remove. */}
            {!isSelfSet(task, mine) && <span className="font-mono">given to you</span>}
          </div>
        </div>

        <div className="flex flex-col items-end gap-1.5 shrink-0">
          {label && onAdvance && (
            <button
              onClick={onAdvance} disabled={busy}
              className={btnClass(task.status === 'In Progress' ? 'success' : 'ghost', 'sm')}
            >
              {Icon && <Icon size={12} />} {label}
            </button>
          )}
          {onReopen && (
            <button onClick={onReopen} disabled={busy} className={btnClass('ghost', 'sm')}>
              <RotateCcw size={12} /> Reopen
            </button>
          )}
          <div className="flex items-center gap-1">
            {task.status !== 'Blocked' && !done && !cancelled && onBlock && (
              <button
                onClick={onBlock} disabled={busy}
                title="Mark blocked" aria-label={`Mark "${task.title}" blocked`}
                className={btnClass('dangerGhost', 'sm')}
              >
                <AlertTriangle size={12} /> Blocked
              </button>
            )}
            {/* 0113 lets you remove work you set yourself and not work somebody gave you, so the
                button is only drawn where the database will honour it. */}
            {isSelfSet(task, mine) && (
              <button
                onClick={onDelete}
                title="Remove from my list" aria-label={`Remove "${task.title}" from my list`}
                className="p-1.5 rounded-lg text-neutral-400 hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-950/40 cursor-pointer"
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}
