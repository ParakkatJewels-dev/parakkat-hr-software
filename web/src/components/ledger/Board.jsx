// The pending tasks as a board (five lanes, drag to change status) or as a list grouped by brand
// with filters and bulk changes. Both open the same update form inline.
import React, { useMemo, useState } from 'react';
import { AlertTriangle, CheckSquare, Link2, Pencil, Pin, Star } from 'lucide-react';
import { useLedgerAction } from '../../data/workLedger';
import { DonePrompt, ProgressForm, TaskEditor } from './TaskForms';
import { BrandMark, OPEN_STATUSES, PRIORITIES, StatusPill, brandRank, dateLabel, errorText, useLedger } from './ui';
import { btnClass } from '../ui/Btn';

export const LANES = [
  { id: 'todo', label: 'To do', statuses: ['Brief'], drop: 'Brief' },
  { id: 'progress', label: 'In progress', statuses: ['In Progress'], drop: 'In Progress' },
  { id: 'review', label: 'In review', statuses: ['Internal Review', 'Awaiting Approval', 'Revisions'], drop: 'Internal Review' },
  { id: 'approved', label: 'Approved', statuses: ['Approved'], drop: 'Approved' },
  { id: 'blocked', label: 'Blocked', statuses: ['Blocked'], drop: 'Blocked' },
];
export const WIP_LIMIT = 3;
export const laneOf = (status) => LANES.find((lane) => lane.statuses.includes(status)) ?? LANES[0];

/** One status move, shown at once and confirmed by the server in the background. */
function useMove() {
  const act = useLedgerAction();
  const move = (task, status) => {
    if (!status || status === task.status) return;
    act.mutate({ name: 'ledger_update_task', args: { _id: task.id, _updates: { status } }, optimistic: { id: task.id, patch: { status } } });
  };
  return { move, error: act.error };
}

function TaskMeta({ task, today }) {
  const overdue = task.deadline && task.deadline < today;
  return (
    <p className="ledger-card-meta">
      {task.type && <span>{task.type}</span>}
      {task.campaign && <span>{task.campaign}</span>}
      {task.priority === 'High' && <span className="ledger-high">High</span>}
      {task.deadline && <span data-overdue={overdue || undefined}>{overdue ? 'Overdue · ' : 'Due '}{dateLabel(task.deadline)}</span>}
      {task.subtasks_total > 0 && <span><CheckSquare size={12} /> {task.subtasks_done}/{task.subtasks_total}</span>}
      {task.waiting_on && <span>Waiting on {task.waiting_on}</span>}
    </p>
  );
}

function TaskChips({ task }) {
  return (
    <>
      {task.stale && <span className="ledger-chip-flag" title="No status change for over 7 days">Stale</span>}
      {task.depends_on_title && <span className="ledger-chip-flag" data-done={task.depends_on_done || undefined} title="Depends on">
        <Link2 size={11} /> {task.depends_on_title}</span>}
      {task.approved_version && task.status === 'Approved' && <span className="ledger-chip-flag" data-tone="good">Approved: {task.approved_version}</span>}
    </>
  );
}

/** A task on the board: title, the details that matter at a glance, and its actions. */
export function TaskCard({ task, pending, onMove, draggable = true }) {
  const { readOnly, today } = useLedger();
  const act = useLedgerAction();
  const [mode, setMode] = useState(null);
  const lane = laneOf(task.status);
  const toggle = (name, args) => act.mutate({ name, args });
  const onKeyDown = (event) => {
    if (readOnly || !event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key) || event.target !== event.currentTarget) return;
    event.preventDefault();
    const index = LANES.indexOf(lane) + (event.key === 'ArrowRight' ? 1 : -1);
    if (LANES[index]) onMove(task, LANES[index].drop);
  };
  return (
    <article className="ledger-card" tabIndex={0} aria-label={task.title} data-focused={task.focused || undefined} data-pinned={task.pinned || undefined}
      draggable={!readOnly && draggable && !mode} onKeyDown={onKeyDown}
      onDragStart={(event) => { event.dataTransfer.setData('text/plain', task.id); event.dataTransfer.effectAllowed = 'move'; }}>
      <header className="ledger-card-head">
        <BrandMark label={task.brand_label} />
        {lane.statuses.length > 1 && <StatusPill status={task.status} />}
        {readOnly ? <span className="ledger-card-marks">
          {task.pinned && <Pin size={13} aria-label="Pinned" />}
          {task.focused && <Star size={13} aria-label="Today’s focus" fill="currentColor" />}
        </span> : <span className="ledger-card-marks">
          <button type="button" className={btnClass('subtle', 'sm', true)} aria-pressed={task.focused} aria-label={task.focused ? 'Remove from today’s focus' : 'Add to today’s focus'}
            onClick={() => toggle('ledger_set_focus', { _id: task.id, _on: !task.focused })}><Star size={14} fill={task.focused ? 'currentColor' : 'none'} /></button>
          <button type="button" className={btnClass('subtle', 'sm', true)} aria-pressed={task.pinned} aria-label={task.pinned ? 'Unpin' : 'Pin to the top'}
            onClick={() => toggle('ledger_set_pin', { _id: task.id, _pinned: !task.pinned })}><Pin size={14} fill={task.pinned ? 'currentColor' : 'none'} /></button>
        </span>}
      </header>
      <h4 className="ledger-card-title">{task.title}</h4>
      <TaskMeta task={task} today={today} />
      <div className="ledger-card-chips"><TaskChips task={task} /></div>
      {task.last_progress && <p className="ledger-card-progress"><span className="ledger-date">{dateLabel(task.last_progress.date)}</span>{task.last_progress.note}</p>}
      {mode === 'done' && <DonePrompt task={task} onDone={() => setMode(null)} />}
      {mode === 'progress' && <ProgressForm task={task} onDone={() => setMode(null)} />}
      {mode === 'cancel' && (
        <div className="ledger-inline-form" role="group" aria-label="Cancel task">
          <span>Cancel this task?</span>
          <button type="button" className={btnClass('ghost')} onClick={() => { toggle('ledger_cancel_task', { _id: task.id }); setMode(null); }}>Yes, cancel it</button>
          <button type="button" className={btnClass('ghost')} onClick={() => setMode(null)}>Keep it</button>
        </div>
      )}
      {mode === 'edit' && <TaskEditor taskId={task.id} pending={pending} onClose={() => setMode(null)} />}
      {!mode && (
        <footer className="ledger-card-actions">
          {readOnly ? <button type="button" className="ledger-text-button" onClick={() => setMode('edit')}>Open</button> : <>
            <button type="button" className="ledger-text-button" onClick={() => setMode('done')}>Done</button>
            <button type="button" className="ledger-text-button" onClick={() => setMode('progress')}>Log progress</button>
            <button type="button" className="ledger-text-button" onClick={() => setMode('edit')}><Pencil size={12} /> Edit</button>
            <button type="button" className="ledger-text-button ledger-quiet-action" onClick={() => setMode('cancel')}>Cancel</button>
            <select className="ledger-move" aria-label={`Move ${task.title} to`} value="" onChange={(event) => onMove(task, event.target.value)}>
              <option value="">Move to…</option>
              {OPEN_STATUSES.filter((status) => status !== task.status).map((status) => <option key={status} value={status}>{status}</option>)}
            </select>
          </>}
        </footer>
      )}
      {act.error && <p className="ledger-alert-inline" role="alert">{errorText(act.error)}</p>}
    </article>
  );
}

export function TaskBoard({ pending }) {
  const { readOnly } = useLedger();
  const { move, error } = useMove();
  const [over, setOver] = useState(null);
  const lanes = LANES.map((lane) => ({ ...lane, tasks: pending.filter((task) => lane.statuses.includes(task.status)) }));
  return (
    <div className="ledger-board-wrap">
      {error && <p className="ledger-alert" role="alert">{errorText(error)}</p>}
      <div className="ledger-board">
        {lanes.map((lane) => (
          <section key={lane.id} className="ledger-lane" aria-label={`${lane.label}, ${lane.tasks.length} tasks`} data-over={over === lane.id || undefined}
            onDragOver={readOnly ? undefined : (event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setOver(lane.id); }}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOver(null); }}
            onDrop={readOnly ? undefined : (event) => {
              event.preventDefault(); setOver(null);
              const task = pending.find((item) => item.id === event.dataTransfer.getData('text/plain'));
              if (task && !lane.statuses.includes(task.status)) move(task, lane.drop);
            }}>
            <h3 className="ledger-lane-head">{lane.label} <span className="ledger-count">{lane.tasks.length}</span></h3>
            {lane.id === 'progress' && lane.tasks.length > WIP_LIMIT && (
              <p className="ledger-wip" role="note"><AlertTriangle size={13} /> {lane.tasks.length} in progress — more than {WIP_LIMIT} at once slows everything down.</p>)}
            {lane.tasks.map((task) => <TaskCard key={task.id} task={task} pending={pending} onMove={move} />)}
            {!lane.tasks.length && <p className="ledger-lane-empty">Nothing here.</p>}
          </section>
        ))}
      </div>
    </div>
  );
}

const matches = (task, filters) => {
  const text = filters.text.trim().toLowerCase();
  if (text && ![task.title, task.vendor, ...(task.tags ?? [])].some((value) => String(value ?? '').toLowerCase().includes(text))) return false;
  if (filters.brand && task.brand !== filters.brand) return false;
  if (filters.type && task.type !== filters.type) return false;
  if (filters.campaign && task.campaign !== filters.campaign) return false;
  if (filters.status && task.status !== filters.status) return false;
  if (filters.overdue && !(task.deadline && task.deadline < filters.today)) return false;
  return true;
};

function RenameTitle({ task }) {
  const { readOnly } = useLedger();
  const act = useLedgerAction();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(task.title);
  if (!editing) {
    return <span className="ledger-item-title" onDoubleClick={readOnly ? undefined : () => { setValue(task.title); setEditing(true); }}
      title={readOnly ? undefined : 'Double-click to rename'}>{task.title}</span>;
  }
  const save = () => {
    setEditing(false);
    if (value.trim() && value.trim() !== task.title) act.mutate({ name: 'ledger_update_task', args: { _id: task.id, _updates: { title: value.trim() } } });
  };
  return <input className="ledger-input ledger-rename" aria-label="Task title" value={value} maxLength={500} autoFocus onChange={(e) => setValue(e.target.value)}
    onBlur={save} onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); } }} />;
}

export function TaskList({ pending, initialFilters = {} }) {
  const { readOnly, boot, today } = useLedger();
  const act = useLedgerAction();
  const [filters, setFilters] = useState({ text: '', brand: '', type: '', campaign: '', status: '', overdue: false, ...initialFilters });
  const [open, setOpen] = useState(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [bulk, setBulk] = useState({ status: '', priority: '', deadline: '' });
  const [message, setMessage] = useState('');
  const options = useMemo(() => ({
    brands: [...new Set(pending.map((t) => t.brand))], types: [...new Set(pending.map((t) => t.type).filter(Boolean))],
    campaigns: [...new Set(pending.map((t) => t.campaign).filter(Boolean))],
  }), [pending]);
  const rank = brandRank(boot);
  const shown = pending.filter((task) => matches(task, { ...filters, today }));
  const groups = [...new Set(shown.map((task) => task.brand))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((brand) => ({ brand, label: shown.find((t) => t.brand === brand)?.brand_label ?? brand, tasks: shown.filter((t) => t.brand === brand) }));
  const set = (key) => (event) => setFilters((current) => ({ ...current, [key]: event.target.value }));
  const pick = (id) => setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const runBulk = async (name, args, done) => {
    setMessage('');
    try { const count = await act.mutateAsync({ name, args }); setMessage(`${done} ${count} task${count === 1 ? '' : 's'}.`); setSelected(new Set()); }
    catch { /* shown below */ }
  };
  const updates = Object.fromEntries(Object.entries(bulk).filter(([, value]) => value));
  return (
    <div className="ledger-list-view">
      <div className="ledger-filters" role="search">
        <input className="ledger-input" type="search" aria-label="Filter tasks" placeholder="Filter by title, tag or vendor" value={filters.text} onChange={set('text')} />
        <select aria-label="Brand" value={filters.brand} onChange={set('brand')}><option value="">All brands</option>{options.brands.map((v) => <option key={v}>{v}</option>)}</select>
        <select aria-label="Type" value={filters.type} onChange={set('type')}><option value="">All types</option>{options.types.map((v) => <option key={v}>{v}</option>)}</select>
        <select aria-label="Campaign" value={filters.campaign} onChange={set('campaign')}><option value="">All campaigns</option>{options.campaigns.map((v) => <option key={v}>{v}</option>)}</select>
        <select aria-label="Status" value={filters.status} onChange={set('status')}><option value="">All statuses</option>{OPEN_STATUSES.map((v) => <option key={v}>{v}</option>)}</select>
        {filters.overdue && <button type="button" className="ledger-chip" aria-pressed="true" onClick={() => setFilters({ ...filters, overdue: false })}>Overdue only ×</button>}
        {!readOnly && <button type="button" className={btnClass('ghost')} aria-pressed={selecting} onClick={() => { setSelecting(!selecting); setSelected(new Set()); }}>
          {selecting ? 'Done selecting' : 'Select'}</button>}
      </div>
      {selecting && (
        <div className="ledger-bulk" role="group" aria-label="Change selected tasks">
          <span>{selected.size} selected</span>
          <button type="button" className="ledger-link" onClick={() => setSelected(new Set(shown.map((t) => t.id)))}>Select all shown</button>
          <button type="button" className={btnClass('primary')} disabled={!selected.size || act.isPending}
            onClick={() => runBulk('ledger_bulk_mark_done', { _ids: [...selected] }, 'Marked done')}>Mark done</button>
          <select aria-label="New status" value={bulk.status} onChange={(e) => setBulk({ ...bulk, status: e.target.value })}><option value="">Status…</option>
            {OPEN_STATUSES.map((v) => <option key={v}>{v}</option>)}</select>
          <select aria-label="New priority" value={bulk.priority} onChange={(e) => setBulk({ ...bulk, priority: e.target.value })}><option value="">Priority…</option>
            {PRIORITIES.map((v) => <option key={v}>{v}</option>)}</select>
          <input type="date" aria-label="New deadline" value={bulk.deadline} onChange={(e) => setBulk({ ...bulk, deadline: e.target.value })} />
          <button type="button" className={btnClass('ghost')} disabled={!selected.size || !Object.keys(updates).length || act.isPending}
            onClick={() => runBulk('ledger_bulk_update', { _ids: [...selected], _updates: updates }, 'Updated')}>Apply</button>
        </div>
      )}
      {act.error && <p className="ledger-alert" role="alert">{errorText(act.error)}</p>}
      {message && <p className="ledger-quiet" role="status">{message}</p>}
      {!groups.length && <p className="ledger-empty">{pending.length ? 'No task matches these filters.' : 'Nothing pending. Press N to add a task.'}</p>}
      {groups.map((group) => (
        <section key={group.brand} className="ledger-section" aria-label={group.label}>
          <h3><BrandMark label={group.label} /> <span className="ledger-count">{group.tasks.length}</span></h3>
          <ul className="ledger-rows-list">
            {group.tasks.map((task) => (
              <li key={task.id} data-open={open === task.id || undefined}>
                <div className="ledger-list-row">
                  {selecting && <input type="checkbox" aria-label={`Select ${task.title}`} checked={selected.has(task.id)} onChange={() => pick(task.id)} />}
                  {task.pinned && <Pin size={13} aria-label="Pinned" />}
                  {task.focused && <Star size={13} aria-label="Today’s focus" fill="currentColor" />}
                  <RenameTitle task={task} />
                  <StatusPill status={task.status} />
                  <TaskMeta task={task} today={today} />
                  <TaskChips task={task} />
                  <button type="button" className="ledger-text-button" aria-expanded={open === task.id} onClick={() => setOpen(open === task.id ? null : task.id)}>
                    {open === task.id ? 'Close' : readOnly ? 'Open' : 'Edit'}</button>
                </div>
                {open === task.id && <TaskEditor taskId={task.id} pending={pending} onClose={() => setOpen(null)} />}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
