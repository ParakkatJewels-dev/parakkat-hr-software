// The Work Ledger's parts of a task, shown inside the task wherever it is opened (the Ledger's board
// and lists, and Task Management's rows): the step it is at and the next moves, waiting on / depends
// on / outcome, today's progress notes, deliverables with versions, and its history. Loaded only
// when the task is open. The rules (rounds of changes, approved version, history, notifications) are
// the database's (0173); this only offers the moves. The creative team also sees brand, work type,
// campaign, vendor and costs (0174).
import React, { useId, useState } from 'react';
import { CheckCircle2, ChevronDown, ExternalLink, History, Layers, Megaphone, NotebookPen, Pin, Star, Trash2 } from 'lucide-react';
import { useAuth } from '../../auth/AuthContext';
import { useWorkHome, useWorkTask, useWorkUpdate, useWorkWrite } from '../../data/work';
import { OFF_STAGES, useCreativeLibrary, useCreativeSettings } from '../../data/creative';
import { humanDbError } from '../../lib/dbErrors';
import { istToday } from '../../lib/dates';
import { btnClass } from '../ui/Btn';

import SearchSelect from '../ui/SearchSelect';
const FIELD = 'w-full min-w-0 text-sm rounded-lg px-2.5 py-1.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-[var(--work-accent,var(--accent))]';
const HEADING = 'flex items-center gap-1.5 text-2xs font-bold uppercase tracking-wide text-neutral-500 dark:text-neutral-400';
const shortDay = (value) => (value ? new Date(`${String(value).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '');

/** The moves that make sense from where a task is. `approver` = may approve (not the person doing it, unless it is their own task). */
export function nextMoves(task, { approver }) {
  if (!task || task.status === 'Cancelled') return [];
  if (task.status === 'Done') return [{ label: 'Reopen', patch: { status: 'In Progress', review_stage: null } }];
  const done = { label: 'Mark done', done: true };
  switch (task.lane) {
    case 'todo': return [{ label: 'Start', patch: { status: 'In Progress', review_stage: null }, primary: true }, done];
    case 'progress': return [
      { label: 'Send for review', patch: { status: 'In Progress', review_stage: 'Internal Review' }, primary: true },
      { label: 'Send for approval', patch: { status: 'In Progress', review_stage: 'Awaiting Approval' } },
      { label: 'Blocked', patch: { status: 'Blocked', review_stage: null } }, done];
    case 'review':
      if (task.review_stage === 'Revisions') return [
        { label: 'Send for review again', patch: { status: 'In Progress', review_stage: 'Internal Review' }, primary: true },
        { label: 'Send for approval', patch: { status: 'In Progress', review_stage: 'Awaiting Approval' } }, done];
      return [
        ...(task.review_stage === 'Internal Review' ? [{ label: 'Send for approval', patch: { status: 'In Progress', review_stage: 'Awaiting Approval' }, primary: !approver }] : []),
        ...(approver ? [{ label: 'Approve', patch: { status: 'In Progress', review_stage: 'Approved' }, primary: true },
          { label: 'Changes needed', patch: { status: 'In Progress', review_stage: 'Revisions' } }] : []),
        done];
    case 'approved': return [{ ...done, primary: true }];
    case 'blocked': return [{ label: 'Unblock', patch: { status: 'In Progress', review_stage: null }, primary: true }, done];
    default: return [done];
  }
}

function TextSetting({ label, value, placeholder, onSave, disabled, maxLength = 200 }) {
  const [draft, setDraft] = useState(null);
  const current = draft ?? value ?? '';
  return (
    <label className="block space-y-1">
      <span className={HEADING}>{label}</span>
      <input className={FIELD} value={current} placeholder={placeholder} maxLength={maxLength} disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (draft !== null && draft.trim() !== (value ?? '')) onSave(draft.trim() || null); setDraft(null); }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
    </label>
  );
}

const WORK_TYPES = ['Print', 'Social', 'Reel', 'Photography', 'Video', 'Ads', 'Website', 'Packaging', 'Event'];

/** A text field with suggestions that saves when you leave it. */
function SuggestSetting({ label, value, options, onSave, disabled, maxLength = 120 }) {
  const listId = useId();
  const [draft, setDraft] = useState(null);
  return (
    <label className="block space-y-1">
      <span className={HEADING}>{label}</span>
      <input className={FIELD} list={listId} value={draft ?? value ?? ''} maxLength={maxLength} disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (draft !== null && draft.trim() !== (value ?? '')) onSave(draft.trim() || null); setDraft(null); }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
      <datalist id={listId}>{[...new Set(options.filter(Boolean))].map((option) => <option key={option} value={option} />)}</datalist>
    </label>
  );
}

function CostSetting({ label, value, onSave, disabled }) {
  const [draft, setDraft] = useState(null);
  const shown = draft ?? (value == null ? '' : String(Number(value)));
  return (
    <label className="block space-y-1">
      <span className={HEADING}>{label}</span>
      <input className={FIELD} inputMode="decimal" placeholder="₹" value={shown} disabled={disabled}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d.]/g, ''))}
        onBlur={() => {
          if (draft !== null) { const next = draft === '' ? null : Number(draft); if (next !== (value == null ? null : Number(value)) && !Number.isNaN(next)) onSave(next); }
          setDraft(null);
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
    </label>
  );
}

/** Brand, work type, campaign, vendor and costs — for the creative team. */
function CreativeFields({ task, canEdit, save }) {
  const library = useCreativeLibrary();
  const data = library.data ?? { brands: [], campaigns: [], vendors: [] };
  const campaigns = data.campaigns.filter((c) => !OFF_STAGES.includes(c.stage) || c.id === task.campaign_id);
  return (
    <div className="space-y-2">
      <p className={HEADING}><Megaphone size={11} /> Creative</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <SuggestSetting label="Brand" value={task.brand} options={data.brands.map((b) => b.name)} disabled={!canEdit} maxLength={80} onSave={(v) => save({ brand: v })} />
        <SuggestSetting label="Work type" value={task.work_type} options={WORK_TYPES} disabled={!canEdit} onSave={(v) => save({ work_type: v })} />
        <label className="block space-y-1">
          <span className={HEADING}>Campaign</span>
          <SearchSelect className={FIELD} disabled={!canEdit} value={task.campaign_id ?? ''} onChange={(e) => save({ campaign_id: e.target.value || null })}>
            <option value="">None</option>
            {task.campaign_id && !campaigns.some((c) => c.id === task.campaign_id) && <option value={task.campaign_id}>{task.campaign ?? 'A removed campaign'}</option>}
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </SearchSelect>
        </label>
        <label className="block space-y-1">
          <span className={HEADING}>Vendor</span>
          <SearchSelect className={FIELD} disabled={!canEdit} value={task.vendor_id ?? ''} onChange={(e) => save({ vendor_id: e.target.value || null })}>
            <option value="">None</option>
            {task.vendor_id && !data.vendors.some((v) => v.id === task.vendor_id) && <option value={task.vendor_id}>{task.vendor ?? 'A removed vendor'}</option>}
            {data.vendors.map((v) => <option key={v.id} value={v.id}>{v.name}{v.role ? ` · ${v.role}` : ''}</option>)}
          </SearchSelect>
        </label>
        <CostSetting label="Estimated cost" value={task.est_cost} disabled={!canEdit} onSave={(v) => save({ est_cost: v })} />
        <CostSetting label="Actual cost" value={task.actual_cost} disabled={!canEdit} onSave={(v) => save({ actual_cost: v })} />
      </div>
    </div>
  );
}

export default function TaskWorkSections({ taskId, open = true, onRemind }) {
  const { employee } = useAuth();
  const detail = useWorkTask(taskId, { enabled: open });
  const home = useWorkHome();
  const creative = Boolean(useCreativeSettings().data?.member);
  const update = useWorkUpdate();
  const write = useWorkWrite();
  const [finishing, setFinishing] = useState(false);
  const [outcome, setOutcome] = useState('');
  const [note, setNote] = useState({ text: '', minutes: '', date: istToday() });
  const [deliverable, setDeliverable] = useState({});
  const [historyOpen, setHistoryOpen] = useState(false);
  if (!open) return null;
  if (detail.isLoading) return <p className="text-xs text-neutral-500" role="status">Loading the task…</p>;
  if (detail.error || !detail.data) return null;
  const task = detail.data;
  const canEdit = Boolean(task.can_edit);
  const ownTask = task.assigned_by === task.employee_id;
  const approver = canEdit && (ownTask || task.employee_id !== employee?.id);
  const moves = canEdit ? nextMoves(task, { approver }) : [];
  const error = update.error || write.error;
  const save = (patch) => update.mutate({ id: task.id, patch });
  const dependsOptions = (home.data?.pending ?? []).filter((t) => t.id !== task.id);

  return (
    <div className="task-work space-y-4">
      {/* Where it is and what happens next */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={HEADING}><Layers size={11} /> Step</span>
          <span className="text-2xs font-bold uppercase px-1.5 py-0.5 rounded bg-brand/10 text-brand-ink">{task.step}</span>
          {task.revision > 0 && <span className="text-2xs text-neutral-500">Round {task.revision + 1} of changes</span>}
          {task.approved_version && <span className="text-2xs text-neutral-500">Approved: {task.approved_version}</span>}
          {task.stale && <span className="text-2xs font-bold uppercase px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">No movement for a week</span>}
          <span className="ml-auto flex items-center gap-1">
            <button type="button" className={btnClass('subtle', 'sm', true)} aria-pressed={task.focused} title={task.focused ? 'Remove from today’s focus' : 'Add to today’s focus'}
              aria-label={task.focused ? 'Remove from today’s focus' : 'Add to today’s focus'}
              onClick={() => write.mutate({ op: 'mark', taskId: task.id, pinned: task.pinned, focus: !task.focused })}>
              <Star size={14} fill={task.focused ? 'currentColor' : 'none'} className={task.focused ? 'text-brand-ink' : ''} /></button>
            <button type="button" className={btnClass('subtle', 'sm', true)} aria-pressed={task.pinned} aria-label={task.pinned ? 'Unpin' : 'Pin to the top'} title={task.pinned ? 'Unpin' : 'Pin to the top'}
              onClick={() => write.mutate({ op: 'mark', taskId: task.id, pinned: !task.pinned, focus: task.focused })}>
              <Pin size={14} fill={task.pinned ? 'currentColor' : 'none'} className={task.pinned ? 'text-brand-ink' : ''} /></button>
            {onRemind && <button type="button" className={btnClass('subtle', 'sm')} onClick={() => onRemind(task)}>Remind me</button>}
          </span>
        </div>
        {moves.length > 0 && !finishing && (
          <div className="flex flex-wrap gap-2">
            {moves.map((move) => (
              <button key={move.label} type="button" disabled={update.isPending} className={btnClass(move.primary ? 'primary' : 'ghost', 'sm')}
                onClick={() => (move.done ? setFinishing(true) : save(move.patch))}>
                {move.done && <CheckCircle2 size={13} />}{move.label}
              </button>
            ))}
          </div>
        )}
        {finishing && (
          <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => {
            e.preventDefault();
            update.mutate({ id: task.id, patch: { status: 'Done', ...(outcome.trim() ? { outcome: outcome.trim() } : {}) } },
              { onSuccess: () => { setFinishing(false); setOutcome(''); } });
          }}>
            <input className={`${FIELD} flex-1`} autoFocus aria-label="Outcome" placeholder="Outcome (optional) — e.g. printed 200 cards" value={outcome}
              maxLength={1000} onChange={(e) => setOutcome(e.target.value)} />
            <button type="submit" className={btnClass('success', 'sm')} disabled={update.isPending}>Mark done</button>
            <button type="button" className={btnClass('ghost', 'sm')} onClick={() => setFinishing(false)}>Cancel</button>
          </form>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {(task.status === 'Blocked' || task.review_stage === 'Awaiting Approval' || task.waiting_on) && (
          <TextSetting label="Waiting on" value={task.waiting_on} placeholder="Who or what" disabled={!canEdit} onSave={(v) => save({ waiting_on: v })} />
        )}
        {(task.status === 'Done' || task.outcome) && (
          <TextSetting label="Outcome" value={task.outcome} placeholder="What it achieved" maxLength={1000} disabled={!canEdit} onSave={(v) => save({ outcome: v })} />
        )}
        <label className="block space-y-1">
          <span className={HEADING}>Depends on</span>
          <SearchSelect className={FIELD} disabled={!canEdit} value={task.depends_on_task_id ?? ''}
            onChange={(e) => save({ depends_on_task_id: e.target.value || null })}>
            <option value="">Nothing</option>
            {task.depends_on_task_id && !dependsOptions.some((t) => t.id === task.depends_on_task_id) && (
              <option value={task.depends_on_task_id}>{task.depends_on_title ?? 'Another task'}</option>)}
            {dependsOptions.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </SearchSelect>
        </label>
        <TextSetting label="Tags" value={(task.tags ?? []).join(', ')} placeholder="comma separated" disabled={!canEdit}
          onSave={(v) => save({ tags: String(v ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 20) })} />
      </div>

      {creative && <CreativeFields task={task} canEdit={canEdit} save={save} />}

      {/* What I did today */}
      <div className="space-y-2">
        <p className={HEADING}><NotebookPen size={11} /> Progress notes</p>
        {canEdit && (
          <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => {
            e.preventDefault();
            if (!note.text.trim()) return;
            write.mutate({ op: 'progress', taskId: task.id, note: note.text.trim(), minutes: Number(note.minutes) || null, date: note.date },
              { onSuccess: () => setNote({ text: '', minutes: '', date: istToday() }) });
          }}>
            <input className={`${FIELD} flex-[1_1_14rem]`} aria-label="What did you do on this?" placeholder="What did you do on this today?" value={note.text}
              maxLength={4000} onChange={(e) => setNote({ ...note, text: e.target.value })} />
            <input className={`${FIELD} w-20`} aria-label="Minutes" placeholder="min" inputMode="numeric" value={note.minutes}
              onChange={(e) => setNote({ ...note, minutes: e.target.value.replace(/\D/g, '') })} />
            <input type="date" className={`${FIELD} w-40`} aria-label="Day" value={note.date} max={istToday()} onChange={(e) => setNote({ ...note, date: e.target.value })} />
            <button type="submit" className={btnClass('ghost', 'sm')} disabled={write.isPending || !note.text.trim()}>Add note</button>
          </form>
        )}
        {task.progress.length === 0 ? <p className="text-xs text-neutral-500">No notes yet.</p> : (
          <ul className="space-y-1.5">
            {task.progress.map((p) => (
              <li key={p.id} className="flex items-start gap-2 text-sm">
                <span className="w-14 shrink-0 text-2xs font-semibold text-neutral-500 tabular-nums pt-0.5">{shortDay(p.date)}</span>
                <span className="flex-1 min-w-0 break-words">{p.note}
                  <span className="text-2xs text-neutral-500">{p.minutes ? ` · ${p.minutes} min` : ''}{p.author ? ` · ${p.author}` : ''}</span></span>
                {p.mine && <button type="button" className={btnClass('subtle', 'sm', true)} aria-label="Remove this note"
                  onClick={() => write.mutate({ op: 'remove-progress', id: p.id })}><Trash2 size={12} /></button>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Versions of the work */}
      <div className="space-y-2">
        <p className={HEADING}><Layers size={11} /> Deliverables</p>
        {task.deliverables.length > 0 && (
          <ul className="space-y-1">
            {task.deliverables.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-semibold">{[d.type, d.version].filter(Boolean).join(' · ') || 'Deliverable'}</span>
                {d.used_where && <span className="text-xs text-neutral-500">— {d.used_where}</span>}
                {d.link && <a className="inline-flex items-center gap-1 text-xs font-bold text-brand-ink hover:underline" href={d.link} target="_blank" rel="noopener noreferrer">Open <ExternalLink size={11} /></a>}
                {canEdit && <button type="button" className={btnClass('subtle', 'sm', true)} aria-label="Remove this deliverable"
                  onClick={() => write.mutate({ op: 'remove-deliverable', id: d.id })}><Trash2 size={12} /></button>}
              </li>
            ))}
          </ul>
        )}
        {canEdit && (
          <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => {
            e.preventDefault();
            if (!deliverable.type?.trim() && !deliverable.link?.trim()) return;
            write.mutate({ op: 'deliverable', taskId: task.id, ...deliverable }, { onSuccess: () => setDeliverable({}) });
          }}>
            {[['type', 'Type, e.g. IG story', 'flex-[1_1_9rem]'], ['version', 'Version', 'w-24'], ['link', 'https://…', 'flex-[1_1_9rem]'], ['used_where', 'Used where', 'flex-[1_1_8rem]']].map(([key, label, width]) => (
              <input key={key} className={`${FIELD} ${width}`} aria-label={label} placeholder={label} value={deliverable[key] ?? ''}
                onChange={(e) => setDeliverable({ ...deliverable, [key]: e.target.value })} />))}
            <button type="submit" className={btnClass('ghost', 'sm')} disabled={write.isPending}>Add</button>
          </form>
        )}
        {!canEdit && task.deliverables.length === 0 && <p className="text-xs text-neutral-500">None yet.</p>}
      </div>

      {/* History */}
      {task.history.length > 0 && (
        <div>
          <button type="button" className={`${HEADING} cursor-pointer`} aria-expanded={historyOpen} onClick={() => setHistoryOpen((v) => !v)}>
            <History size={11} /> History <ChevronDown size={11} className={historyOpen ? 'rotate-180' : ''} />
          </button>
          {historyOpen && (
            <ul className="mt-2 space-y-1 text-xs text-neutral-600 dark:text-neutral-300">
              {task.history.map((h, index) => (
                <li key={`${h.at}-${index}`}><span className="text-neutral-500 tabular-nums">{shortDay(h.at)}</span>{' '}
                  {h.kind === 'created' ? `Created at ${h.to}` : h.kind === 'step' ? `${h.from} → ${h.to}` : h.kind === 'assignee' ? `Handed from ${h.from ?? '—'} to ${h.to ?? '—'}`
                    : `Due date ${h.from ? shortDay(h.from) : 'none'} → ${h.to ? shortDay(h.to) : 'none'}`}
                  {h.by ? <span className="text-neutral-500"> · {h.by}</span> : null}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">{humanDbError(error, 'tasks')}</p>}
    </div>
  );
}
