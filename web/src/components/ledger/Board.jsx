// My work as a board: five lanes worked out from each task's status and review step. Drag a card to
// another lane (or use "Move to…" / Alt+arrows) and the task itself moves — the same record Task
// Management shows. Done asks for an optional outcome; a progress note goes straight onto the task.
// On phones the lanes are a row you swipe through, and a card is dragged by pressing and holding it
// (boardTouch.js); computers keep HTML5 drag-and-drop.
import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CalendarDays, Check, CheckSquare, Link2, MessageSquare, Paperclip, Pin, Plus, Star } from 'lucide-react';
import { initialsOf, tintFor } from '../ui/Avatar';
import { LANE_TARGETS, useWorkUpdate, useWorkWrite } from '../../data/work';
import { humanDbError } from '../../lib/dbErrors';
import { istToday } from '../../lib/dates';
import { btnClass } from '../ui/Btn';
import { StatusPill, dateLabel, errorText, useLedger } from './ui';
import { attachBoardTouchDrag, lanesInView, showLane } from './boardTouch';

export const LANES = [
  { id: 'todo', label: 'To do' },
  { id: 'progress', label: 'In progress' },
  { id: 'review', label: 'In review' },
  { id: 'approved', label: 'Approved' },
  { id: 'blocked', label: 'Blocked' },
];
export const WIP_LIMIT = 3;

function ProgressForm({ task, onDone }) {
  const write = useWorkWrite();
  const [note, setNote] = useState('');
  const [minutes, setMinutes] = useState('');
  const submit = (event) => {
    event.preventDefault();
    if (!note.trim()) return;
    write.mutate({ op: 'progress', taskId: task.id, note: note.trim(), minutes: Number(minutes) || null, date: istToday() }, { onSuccess: onDone });
  };
  return (
    <form className="ledger-inline-form" onSubmit={submit}>
      <input className="ledger-input" aria-label={`Progress on ${task.title}`} placeholder="What did you do on this today?" value={note} maxLength={4000}
        onChange={(e) => setNote(e.target.value)} autoFocus />
      <input className="ledger-input ledger-input-small" aria-label="Minutes" placeholder="min" inputMode="numeric" value={minutes}
        onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ''))} />
      <button type="submit" className={btnClass('primary', 'sm')} disabled={write.isPending || !note.trim()}>Log</button>
      <button type="button" className={btnClass('ghost', 'sm')} onClick={onDone}>Cancel</button>
      {write.error && <span className="ledger-alert-inline" role="alert">{errorText(write.error)}</span>}
    </form>
  );
}

function DonePrompt({ task, onDone }) {
  const update = useWorkUpdate();
  const [outcome, setOutcome] = useState('');
  const submit = (event) => {
    event.preventDefault();
    update.mutate({ id: task.id, patch: { status: 'Done', ...(outcome.trim() ? { outcome: outcome.trim() } : {}) } }, { onSuccess: onDone });
  };
  return (
    <form className="ledger-inline-form" onSubmit={submit}>
      <input className="ledger-input" aria-label={`Outcome for ${task.title}`} placeholder="Outcome (optional)" value={outcome} maxLength={1000}
        onChange={(e) => setOutcome(e.target.value)} autoFocus />
      <button type="submit" className={btnClass('success', 'sm')} disabled={update.isPending}>Mark done</button>
      <button type="button" className={btnClass('ghost', 'sm')} onClick={onDone}>Cancel</button>
      {update.error && <span className="ledger-alert-inline" role="alert">{humanDbError(update.error, 'tasks')}</span>}
    </form>
  );
}

function CardMeta({ task, today, me }) {
  const overdue = task.due_date && task.due_date < today;
  const dueToday = task.due_date === today;
  const owner = task.assignee_name && task.employee_id !== me ? task.assignee_name : null;
  return (
    <div className="ledger-card-meta">
      {owner && <span className="ledger-card-owner"><span className={`ledger-card-avatar ${tintFor(owner)}`} aria-hidden="true">{initialsOf(owner)}</span>{owner}</span>}
      {task.due_date && (
        <span className="ledger-due-chip" data-tone={overdue || dueToday ? 'bad' : 'info'} data-overdue={overdue || undefined}>
          <CalendarDays size={12} aria-hidden="true" />{overdue ? 'Overdue · ' : dueToday ? '' : 'Due '}{dueToday ? 'Due today' : dateLabel(task.due_date)}
        </span>)}
      {['High', 'Urgent'].includes(task.priority) && <span className="ledger-high">{task.priority}</span>}
      {task.subtasks_total > 0 && <span><CheckSquare size={12} /> {task.subtasks_done}/{task.subtasks_total}</span>}
      {task.comments_count > 0 && <span><MessageSquare size={12} /> {task.comments_count}</span>}
      {task.attachments_count > 0 && <span><Paperclip size={12} /> {task.attachments_count}</span>}
      {task.waiting_on && <span>Waiting on {task.waiting_on}</span>}
    </div>
  );
}

/** A task on the board. */
export function TaskCard({ task, onMove, onOpen, dragging = false }) {
  const { today, employeeId } = useLedger();
  const write = useWorkWrite();
  const [mode, setMode] = useState(null);
  const canEdit = Boolean(task.can_edit);
  const laneIndex = LANES.findIndex((lane) => lane.id === task.lane);
  const onKeyDown = (event) => {
    if (!canEdit || !event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key) || event.target !== event.currentTarget) return;
    event.preventDefault();
    const next = LANES[laneIndex + (event.key === 'ArrowRight' ? 1 : -1)];
    if (next) onMove(task, next.id);
  };
  return (
    <article className="ledger-card" tabIndex={0} aria-label={task.title} data-focused={task.focused || undefined} data-pinned={task.pinned || undefined}
      data-task-id={task.id} data-dragging={dragging || undefined} draggable={canEdit && !mode} onKeyDown={onKeyDown}
      onDragStart={(event) => { event.dataTransfer.setData('text/plain', task.id); event.dataTransfer.effectAllowed = 'move'; }}>
      <header className="ledger-card-head">
        {canEdit && (
          <button type="button" className="ledger-card-check" aria-label={`Mark "${task.title}" done`} title="Mark done"
            aria-pressed={mode === 'done'} onClick={() => setMode(mode === 'done' ? null : 'done')}><Check size={13} /></button>
        )}
        <h4 className="ledger-card-title"><button type="button" className="ledger-card-open" onClick={() => onOpen(task.id)}>{task.title}</button></h4>
        <span className="ledger-card-marks">
          <button type="button" className={btnClass('subtle', 'sm', true)} aria-pressed={task.focused}
            aria-label={task.focused ? 'Remove from today’s focus' : 'Add to today’s focus'}
            onClick={() => write.mutate({ op: 'mark', taskId: task.id, pinned: task.pinned, focus: !task.focused })}><Star size={14} fill={task.focused ? 'currentColor' : 'none'} /></button>
          <button type="button" className={btnClass('subtle', 'sm', true)} aria-pressed={task.pinned} aria-label={task.pinned ? 'Unpin' : 'Pin to the top'}
            onClick={() => write.mutate({ op: 'mark', taskId: task.id, pinned: !task.pinned, focus: task.focused })}><Pin size={14} fill={task.pinned ? 'currentColor' : 'none'} /></button>
        </span>
      </header>
      {task.lane === 'review' && <div className="ledger-card-step"><StatusPill status={task.step} /></div>}
      <CardMeta task={task} today={today} me={employeeId} />
      <div className="ledger-card-chips">
        {task.stale && <span className="ledger-chip-flag" title="No movement for over 7 days">Stale</span>}
        {task.depends_on_title && <span className="ledger-chip-flag" data-done={task.depends_on_done || undefined} title="Depends on"><Link2 size={11} /> {task.depends_on_title}</span>}
        {task.approved_version && task.lane === 'approved' && <span className="ledger-chip-flag" data-tone="good">Approved: {task.approved_version}</span>}
        {task.revision > 0 && task.lane === 'review' && <span className="ledger-chip-flag">Round {task.revision + 1}</span>}
      </div>
      {task.last_progress && <p className="ledger-card-progress"><span className="ledger-date">{dateLabel(task.last_progress.date)}</span>{task.last_progress.note}</p>}
      {mode === 'done' && <DonePrompt task={task} onDone={() => setMode(null)} />}
      {mode === 'progress' && <ProgressForm task={task} onDone={() => setMode(null)} />}
      {!mode && (
        <footer className="ledger-card-actions">
          {canEdit && <button type="button" className="ledger-text-button" onClick={() => setMode('progress')}>Log progress</button>}
          <button type="button" className="ledger-text-button" onClick={() => onOpen(task.id)}>Open</button>
          {canEdit && (
            <select className="ledger-move" aria-label={`Move ${task.title} to`} value="" onChange={(event) => onMove(task, event.target.value)}>
              <option value="">Move to…</option>
              {LANES.filter((lane) => lane.id !== task.lane).map((lane) => <option key={lane.id} value={lane.id}>{lane.label}</option>)}
            </select>
          )}
        </footer>
      )}
      {write.error && <p className="ledger-alert-inline" role="alert">{errorText(write.error)}</p>}
    </article>
  );
}

export function TaskBoard({ tasks, onOpen, onAdd }) {
  const update = useWorkUpdate();
  const [over, setOver] = useState(null);
  const [dragId, setDragId] = useState(null);
  const [inView, setInView] = useState([0]);
  const boardRef = useRef(null);
  const latest = useRef(null);
  const move = (task, laneId) => {
    if (!LANE_TARGETS[laneId] || laneId === task.lane) return;
    update.mutate({ id: task.id, patch: LANE_TARGETS[laneId] });
  };
  latest.current = { tasks, move };
  const syncInView = () => setInView((was) => { const now = lanesInView(boardRef.current); return now.join() === was.join() ? was : now; });
  // Touch and pen: press and hold a card to pick it up (mouse drags stay HTML5 below).
  useEffect(() => {
    const board = boardRef.current;
    const touch = attachBoardTouchDrag(board, {
      taskFor: (id) => latest.current.tasks.find((task) => task.id === id),
      onLift: (task) => setDragId(task.id),
      onOver: setOver,
      onDrop: (task, laneId) => {
        const current = latest.current.tasks.find((item) => item.id === task.id) ?? task;
        if (current.can_edit) latest.current.move(current, laneId);
      },
      onEnd: () => { setDragId(null); setOver(null); },
    });
    syncInView();
    window.addEventListener('resize', syncInView);
    return () => { touch.destroy(); window.removeEventListener('resize', syncInView); };
  }, []);
  const frame = useRef(0);
  const onScroll = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => { frame.current = 0; syncInView(); });
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const lanes = LANES.map((lane) => ({ ...lane, tasks: tasks.filter((task) => task.lane === lane.id) }));
  return (
    <div className="ledger-board-wrap">
      {update.error && <p className="ledger-alert" role="alert">{humanDbError(update.error, 'tasks')}</p>}
      {/* Phones: which lane is in view; tap a dot to jump to that lane. */}
      <div className="ledger-board-dots" role="group" aria-label="Board lanes">
        {lanes.map((lane, index) => (
          <button key={lane.id} type="button" className="ledger-board-dot" aria-label={`Show ${lane.label}, ${lane.tasks.length} tasks`}
            aria-current={inView.includes(index) || undefined} onClick={() => showLane(boardRef.current, lane.id)} />
        ))}
      </div>
      <div className="ledger-board" ref={boardRef} onScroll={onScroll}>
        {lanes.map((lane) => (
          <section key={lane.id} className="ledger-lane" data-lane-id={lane.id} aria-label={`${lane.label}, ${lane.tasks.length} tasks`} data-over={over === lane.id || undefined}
            onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setOver(lane.id); }}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOver(null); }}
            onDrop={(event) => {
              event.preventDefault(); setOver(null);
              const task = tasks.find((item) => item.id === event.dataTransfer.getData('text/plain'));
              if (task?.can_edit) move(task, lane.id);
            }}>
            <h3 className="ledger-lane-head">{lane.label} <span className="ledger-count">{lane.tasks.length}</span>
              {onAdd && lane.id === 'todo' && <button type="button" className="ledger-lane-add" aria-label="Add a task" title="Add a task" onClick={onAdd}><Plus size={16} /></button>}</h3>
            {lane.id === 'progress' && lane.tasks.length > WIP_LIMIT && (
              <p className="ledger-wip" role="note"><AlertTriangle size={13} /> {lane.tasks.length} in progress — more than {WIP_LIMIT} at once slows everything down.</p>)}
            {lane.tasks.map((task) => <TaskCard key={task.id} task={task} onMove={move} onOpen={onOpen} dragging={dragId === task.id} />)}
            {!lane.tasks.length && <p className="ledger-lane-empty">Nothing here.</p>}
          </section>
        ))}
      </div>
    </div>
  );
}
