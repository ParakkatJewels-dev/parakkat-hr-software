// Forms for the Work Ledger's tasks: the New task and Log help drawers, reminders, the small
// progress / done prompts on a card, and the full update form shared by the board and the list.
import React, { useMemo, useState } from 'react';
import { ExternalLink, Paperclip, Plus, Trash2, X } from 'lucide-react';
import { newId, signedFileUrl, syncGoogleCalendar, uploadLedgerFile, useLedgerAction, useLedgerTask } from '../../data/workLedger';
import Drawer from './Drawer';
import { Field, Message, OPEN_STATUSES, PRIORITIES, REPEATS, STATUSES, Suggest, WORK_TYPES, dateLabel, errorText, money, useLedger } from './ui';

const blankBrief = { objective: '', audience: '', message: '', deliverables: '', references: '' };
const clean = (value) => (typeof value === 'string' ? value.trim() : value);
const usedNames = (boot, key) => (boot?.[key] ?? []).map((item) => (typeof item === 'string' ? item : item.name));

function BrandPicker({ value, onChange }) {
  const { boot } = useLedger();
  const brands = boot?.brands ?? [];
  const known = brands.some((brand) => brand.name === value);
  return (
    <div className="ledger-brand-picker" role="radiogroup" aria-label="Brand">
      {brands.map((brand) => (
        <button key={brand.id} type="button" role="radio" aria-checked={value === brand.name} className="ledger-chip" onClick={() => onChange(brand.name)}>{brand.label}</button>
      ))}
      <input className="ledger-input ledger-input-inline" aria-label="Other brand" placeholder="Other…" value={known ? '' : value ?? ''} maxLength={80}
        onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

function RowsEditor({ rows, onChange, fields, addLabel }) {
  return (
    <div className="ledger-rows">
      {rows.map((row, index) => (
        <div key={index} className="ledger-row">
          {fields.map(([key, label, width]) => (
            <input key={key} className="ledger-input" aria-label={label} placeholder={label} value={row[key] ?? ''} style={width ? { flex: width } : undefined}
              onChange={(event) => onChange(rows.map((item, i) => (i === index ? { ...item, [key]: event.target.value } : item)))} />
          ))}
          <button type="button" className="ledger-icon-button" aria-label={`Remove ${addLabel.toLowerCase()} ${index + 1}`} onClick={() => onChange(rows.filter((_, i) => i !== index))}><X size={15} /></button>
        </div>
      ))}
      <button type="button" className="ledger-link" onClick={() => onChange([...rows, {}])}><Plus size={13} /> {addLabel}</button>
    </div>
  );
}

/** N — the full New task drawer (webAddEntry and its children). */
export function NewTaskDrawer({ initial = {}, onClose, onSaved }) {
  const { boot, owner } = useLedger();
  const act = useLedgerAction();
  const [form, setForm] = useState({ brand: 'General', status: 'Brief', priority: 'Medium', repeat: '', ...initial });
  const [brief, setBrief] = useState({ ...blankBrief, ...(initial.brief ?? {}) });
  const [showBrief, setShowBrief] = useState(false);
  const [subtasks, setSubtasks] = useState(initial.subtasks ?? []);
  const [step, setStep] = useState('');
  const [progress, setProgress] = useState('');
  const [deliverables, setDeliverables] = useState([]);
  const [links, setLinks] = useState([]);
  const [files, setFiles] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }));
  const applyTemplate = (name) => {
    const template = (boot?.templates ?? []).find((item) => item.name === name);
    if (!template) return;
    setForm((current) => ({ ...current, type: current.type || template.type || '' }));
    setSubtasks((current) => [...current, ...template.subtasks.filter((s) => !current.includes(s))]);
  };
  const submit = async (event) => {
    event.preventDefault();
    if (busy || !clean(form.task)) { setError(clean(form.task) ? null : new Error('Give the task a title.')); return; }
    setBusy(true); setError(null);
    const id = newId();
    try {
      const briefFilled = Object.fromEntries(Object.entries(brief).filter(([, v]) => clean(v)));
      await act.mutateAsync({ name: 'ledger_add_task', args: { _id: id, _entry: {
        task: clean(form.task), brand: clean(form.brand) || 'General', type: clean(form.type), campaign: clean(form.campaign), status: form.status,
        waiting_on: ['Blocked', 'Awaiting Approval'].includes(form.status) ? clean(form.waiting_on) : null, priority: form.priority,
        start_date: form.start_date || null, end_date: form.end_date || null, deadline: form.deadline || null, repeat: form.repeat || null,
        vendor: clean(form.vendor), est_cost: form.est_cost || null, tags: clean(form.tags) ?? '', notes: clean(form.notes),
        brief: Object.keys(briefFilled).length ? briefFilled : null, idea_id: initial.idea_id ?? null,
        subtasks: clean(step) ? [...subtasks, clean(step)] : subtasks, deliverables: deliverables.filter((d) => clean(d.type) || clean(d.link)),
        links: links.filter((l) => /^https?:\/\//i.test(clean(l.url) ?? '')).map((l) => ({ name: clean(l.name), url: clean(l.url) })),
      } } });
      for (const [index, file] of files.entries()) {
        setProgress(`Uploading ${index + 1} of ${files.length}…`);
        await uploadLedgerFile({ owner: boot?.owner?.user_id ?? owner, taskId: id, file });
      }
      onSaved?.(id);
      onClose();
    } catch (failure) { setError(failure); setProgress(''); }
    finally { setBusy(false); }
  };
  const onDrop = (event) => { event.preventDefault(); setFiles((current) => [...current, ...event.dataTransfer.files]); };
  return (
    <Drawer title="New task" subtitle="Add to your ledger" onClose={onClose} initialFocus="#ledger-new-title"
      footer={<><span className="ledger-quiet">{progress}</span><button type="submit" form="ledger-new-task" className="ledger-button ledger-button-primary" disabled={busy}>{busy ? 'Saving…' : 'Add to ledger'}</button></>}>
      <form id="ledger-new-task" className="ledger-form" onSubmit={submit} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        <Field label="Brand" wide><BrandPicker value={form.brand} onChange={set('brand')} /></Field>
        {(boot?.templates ?? []).length > 0 && <Field label="Start from a template" wide>
          <select className="ledger-input" value="" onChange={(e) => applyTemplate(e.target.value)}>
            <option value="">Choose…</option>{boot.templates.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
          </select></Field>}
        <Field label="Task" wide><input id="ledger-new-title" className="ledger-input" value={form.task ?? ''} maxLength={500} onChange={(e) => set('task')(e.target.value)} required /></Field>
        <Field label="Type"><Suggest value={form.type} onChange={set('type')} options={[...WORK_TYPES, ...(boot?.used_types ?? [])]} /></Field>
        <Field label="Campaign" hint="type to create"><Suggest value={form.campaign} onChange={set('campaign')} options={usedNames(boot, 'campaigns')} /></Field>
        <Field label="Status"><select className="ledger-input" value={form.status} onChange={(e) => set('status')(e.target.value)}>
          {OPEN_STATUSES.map((s) => <option key={s}>{s}</option>)}</select></Field>
        {['Blocked', 'Awaiting Approval'].includes(form.status) && <Field label="Waiting on"><input className="ledger-input" value={form.waiting_on ?? ''} maxLength={200} onChange={(e) => set('waiting_on')(e.target.value)} /></Field>}
        <Field label="Priority"><select className="ledger-input" value={form.priority} onChange={(e) => set('priority')(e.target.value)}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></Field>
        <Field label="Start"><input type="date" className="ledger-input" value={form.start_date ?? ''} onChange={(e) => set('start_date')(e.target.value)} /></Field>
        <Field label="End"><input type="date" className="ledger-input" value={form.end_date ?? ''} onChange={(e) => set('end_date')(e.target.value)} /></Field>
        <Field label="Deadline"><input type="date" className="ledger-input" value={form.deadline ?? ''} onChange={(e) => set('deadline')(e.target.value)} /></Field>
        <Field label="Repeat"><select className="ledger-input" value={form.repeat} onChange={(e) => set('repeat')(e.target.value)}>{REPEATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <Field label="Vendor"><Suggest value={form.vendor} onChange={set('vendor')} options={usedNames(boot, 'vendors')} /></Field>
        <Field label="Est. cost" hint="₹"><input className="ledger-input" inputMode="numeric" value={form.est_cost ?? ''} onChange={(e) => set('est_cost')(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
        <Field label="Tags" hint="comma separated" wide><input className="ledger-input" value={form.tags ?? ''} onChange={(e) => set('tags')(e.target.value)} /></Field>
        <div className="ledger-form-wide">
          <button type="button" className="ledger-link" aria-expanded={showBrief} onClick={() => setShowBrief((v) => !v)}>{showBrief ? 'Hide' : 'Add a'} creative brief</button>
          {showBrief && <div className="ledger-form ledger-subform">
            {[['objective', 'Objective'], ['audience', 'Audience'], ['message', 'Key message'], ['deliverables', 'Deliverables & sizes'], ['references', 'References']].map(([key, label]) => (
              <Field key={key} label={label} wide><textarea className="ledger-input" rows={2} value={brief[key]} onChange={(e) => setBrief({ ...brief, [key]: e.target.value })} /></Field>))}
          </div>}
        </div>
        <Field label="Notes" wide><textarea className="ledger-input" rows={2} value={form.notes ?? ''} onChange={(e) => set('notes')(e.target.value)} /></Field>
        <Field label="Subtasks" wide>
          <div className="ledger-rows">
            {subtasks.map((s, i) => <div key={i} className="ledger-row"><span className="ledger-row-text">{s}</span>
              <button type="button" className="ledger-icon-button" aria-label={`Remove subtask ${s}`} onClick={() => setSubtasks(subtasks.filter((_, x) => x !== i))}><X size={15} /></button></div>)}
            <div className="ledger-row"><input className="ledger-input" aria-label="New subtask" placeholder="Add a step and press Enter" value={step}
              onChange={(e) => setStep(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (clean(step)) { setSubtasks([...subtasks, clean(step)]); setStep(''); } } }} /></div>
          </div>
        </Field>
        <Field label="Deliverables" wide><RowsEditor rows={deliverables} onChange={setDeliverables} addLabel="Add deliverable"
          fields={[['type', 'Type, e.g. IG story', 2], ['version', 'Version', 1], ['link', 'Link', 2], ['used_where', 'Used where', 2]]} /></Field>
        <Field label="Links" hint="Canva, Figma, Drive…" wide><RowsEditor rows={links} onChange={setLinks} addLabel="Add link" fields={[['name', 'Label', 1], ['url', 'https://…', 2]]} /></Field>
        <Field label="Attach files" hint="up to 50 MB each, or drop them here" wide>
          <input type="file" multiple className="ledger-input" onChange={(e) => setFiles([...files, ...e.target.files])} />
        </Field>
        {files.length > 0 && <p className="ledger-quiet ledger-form-wide">{files.map((f) => f.name).join(', ')}</p>}
        <Message error={error} />
      </form>
    </Drawer>
  );
}

/** H — Log help / review. The only way a support entry is written. */
export function LogHelpDrawer({ initial = {}, onClose }) {
  const { boot, today } = useLedger();
  const act = useLedgerAction();
  const [form, setForm] = useState({ type: 'Review / Feedback', brand: 'General', date: today, ...initial });
  const [error, setError] = useState(null);
  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    try {
      await act.mutateAsync({ name: 'ledger_log_support', args: { _id: newId(), _entry: {
        what: clean(form.what), for_whom: clean(form.for_whom), brand: form.brand, type: form.type,
        minutes: form.minutes ? Number(form.minutes) : null, note: clean(form.note), date: form.date || today } } });
      onClose();
    } catch (failure) { setError(failure); }
  };
  return (
    <Drawer title="Log help or a review" subtitle="Counts under Support & reviews, never on the board" onClose={onClose} initialFocus="#ledger-help-what"
      footer={<button type="submit" form="ledger-help" className="ledger-button ledger-button-primary" disabled={act.isPending}>Save</button>}>
      <form id="ledger-help" className="ledger-form" onSubmit={submit}>
        <Field label="What you did" wide><input id="ledger-help-what" className="ledger-input" required maxLength={500} value={form.what ?? ''} onChange={(e) => set('what')(e.target.value)} /></Field>
        <Field label="For whom"><Suggest value={form.for_whom} onChange={set('for_whom')} options={boot?.people ?? []} maxLength={120} /></Field>
        <Field label="Minutes"><input className="ledger-input" inputMode="numeric" value={form.minutes ?? ''} onChange={(e) => set('minutes')(e.target.value.replace(/\D/g, ''))} /></Field>
        <Field label="Brand" wide><BrandPicker value={form.brand} onChange={set('brand')} /></Field>
        <Field label="Type"><select className="ledger-input" value={form.type} onChange={(e) => set('type')(e.target.value)}>
          <option>Review / Feedback</option><option>Team support</option></select></Field>
        <Field label="Day"><input type="date" className="ledger-input" value={form.date} max={today} onChange={(e) => set('date')(e.target.value)} /></Field>
        <Field label="Notes" wide><textarea className="ledger-input" rows={2} value={form.note ?? ''} onChange={(e) => set('note')(e.target.value)} /></Field>
        <Message error={error} />
      </form>
    </Drawer>
  );
}

/** R — a reminder, mirrored to Google Calendar when it is connected. */
export function ReminderDrawer({ initial = {}, onClose }) {
  const { today } = useLedger();
  const act = useLedgerAction();
  const [form, setForm] = useState({ date: today, time: '09:00', repeat: '', ...initial });
  const [error, setError] = useState(null);
  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    try {
      const saved = await act.mutateAsync({ name: initial.task_id && initial.followUp ? 'ledger_add_follow_up' : 'ledger_add_reminder',
        args: initial.task_id && initial.followUp
          ? { _id: newId(), _task: initial.task_id, _text: clean(form.text), _due_at: `${form.date}T${form.time}` }
          : { _id: newId(), _r: { text: clean(form.text), due_at: `${form.date}T${form.time}`, repeat: form.repeat || null, task_id: initial.task_id ?? null } } });
      if (saved?.calendar) await syncGoogleCalendar().catch(() => {});
      onClose();
    } catch (failure) { setError(failure); }
  };
  return (
    <Drawer title={initial.followUp ? 'Follow-up' : 'Reminder'} subtitle={initial.task_title} onClose={onClose} initialFocus="#ledger-reminder-text"
      footer={<button type="submit" form="ledger-reminder" className="ledger-button ledger-button-primary" disabled={act.isPending}>Save reminder</button>}>
      <form id="ledger-reminder" className="ledger-form" onSubmit={submit}>
        <Field label="Remind me to" wide><input id="ledger-reminder-text" className="ledger-input" required maxLength={500} value={form.text ?? ''} onChange={(e) => set('text')(e.target.value)} /></Field>
        <Field label="Day"><input type="date" className="ledger-input" required value={form.date} onChange={(e) => set('date')(e.target.value)} /></Field>
        <Field label="Time"><input type="time" className="ledger-input" required value={form.time} onChange={(e) => set('time')(e.target.value)} /></Field>
        {!initial.followUp && <Field label="Repeat"><select className="ledger-input" value={form.repeat} onChange={(e) => set('repeat')(e.target.value)}>{REPEATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>}
        <Message error={error} />
      </form>
    </Drawer>
  );
}

/** "What I did on this today" on a card. */
export function ProgressForm({ task, onDone }) {
  const { today } = useLedger();
  const act = useLedgerAction();
  const [note, setNote] = useState('');
  const [minutes, setMinutes] = useState('');
  const [day, setDay] = useState(today);
  const submit = async (event) => {
    event.preventDefault();
    if (!note.trim()) return;
    await act.mutateAsync({ name: 'ledger_log_progress', args: { _id: newId(), _task: task.id, _note: note.trim(), _minutes: minutes ? Number(minutes) : null, _date: day } });
    onDone();
  };
  return (
    <form className="ledger-inline-form" onSubmit={submit}>
      <input className="ledger-input" aria-label={`Progress on ${task.title}`} placeholder="What did you do on this?" value={note} maxLength={4000} onChange={(e) => setNote(e.target.value)} autoFocus />
      <input className="ledger-input ledger-input-small" aria-label="Minutes" placeholder="min" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ''))} />
      <input type="date" className="ledger-input ledger-input-date" aria-label="Day" value={day} max={today} onChange={(e) => setDay(e.target.value)} />
      <button type="submit" className="ledger-button ledger-button-primary" disabled={act.isPending || !note.trim()}>Log</button>
      <button type="button" className="ledger-button" onClick={onDone}>Cancel</button>
      {act.error && <span className="ledger-alert-inline" role="alert">{errorText(act.error)}</span>}
    </form>
  );
}

/** Done, with an optional outcome line. */
export function DonePrompt({ task, onDone }) {
  const act = useLedgerAction();
  const [outcome, setOutcome] = useState(task.outcome ?? '');
  const submit = async (event) => {
    event.preventDefault();
    await act.mutateAsync({ name: 'ledger_mark_done', args: { _id: task.id, _outcome: outcome.trim() || null } });
    onDone();
  };
  return (
    <form className="ledger-inline-form" onSubmit={submit}>
      <input className="ledger-input" aria-label={`Outcome for ${task.title}`} placeholder="Outcome (optional)" value={outcome} maxLength={1000} onChange={(e) => setOutcome(e.target.value)} autoFocus />
      <button type="submit" className="ledger-button ledger-button-primary" disabled={act.isPending}>Mark done</button>
      <button type="button" className="ledger-button" onClick={onDone}>Cancel</button>
      {act.error && <span className="ledger-alert-inline" role="alert">{errorText(act.error)}</span>}
    </form>
  );
}

const EDITABLE = ['title', 'brand', 'type', 'campaign', 'status', 'waiting_on', 'priority', 'deadline', 'start_date', 'end_date', 'repeat', 'vendor',
  'est_cost', 'actual_cost', 'outcome', 'depends_on'];

/** The update form: every field, children, history. Only changed fields are sent (partial update). */
export function TaskEditor({ taskId, pending = [], onClose }) {
  const { owner, readOnly, boot } = useLedger();
  const detail = useLedgerTask(taskId, owner);
  const act = useLedgerAction();
  const task = detail.data;
  const [draft, setDraft] = useState(null);
  const [note, setNote] = useState('');
  const [tags, setTags] = useState(null);
  const [saved, setSaved] = useState('');
  const [newStep, setNewStep] = useState('');
  const [deliverable, setDeliverable] = useState({});
  const [link, setLink] = useState({});
  const [error, setError] = useState(null);
  const values = useMemo(() => (task ? { ...Object.fromEntries(EDITABLE.map((k) => [k, task[k] ?? ''])), ...draft } : {}), [task, draft]);
  if (detail.isLoading) return <p className="ledger-quiet">Opening…</p>;
  if (detail.error || !task) return <Message error={detail.error ?? new Error('Task not found.')} />;
  const set = (key) => (value) => setDraft((current) => ({ ...current, [key]: value }));
  const run = async (name, args, message) => {
    setError(null);
    try { await act.mutateAsync({ name, args }); await detail.refetch(); if (message) setSaved(message); }
    catch (failure) { setError(failure); }
  };
  const save = async (event) => {
    event.preventDefault();
    const updates = {};
    for (const [key, value] of Object.entries(draft ?? {})) {
      if (String(value ?? '') !== String(task[key] ?? '')) updates[key] = value === '' ? null : value;
    }
    if (tags !== null && tags !== (task.tags ?? []).join(', ')) updates.tags = tags;
    if (note.trim()) updates.note = note.trim();
    if (!Object.keys(updates).length) { setSaved('Nothing changed.'); return; }
    await run('ledger_update_task', { _id: task.id, _updates: updates }, 'Saved.');
    setDraft(null); setNote(''); setTags(null);
  };
  const openFile = async (path) => { try { window.open(await signedFileUrl(path), '_blank', 'noopener'); } catch (failure) { setError(failure); } };
  const disabled = readOnly;
  return (
    <form className="ledger-editor" onSubmit={save} aria-label={`Edit ${task.title}`}>
      <div className="ledger-form">
        <Field label="Task" wide><input className="ledger-input" disabled={disabled} value={values.title} maxLength={500} onChange={(e) => set('title')(e.target.value)} /></Field>
        <Field label="Brand"><Suggest disabled={disabled} value={values.brand} onChange={set('brand')} options={usedNames(boot, 'brands')} maxLength={80} /></Field>
        <Field label="Type"><Suggest disabled={disabled} value={values.type} onChange={set('type')} options={[...WORK_TYPES, ...(boot?.used_types ?? [])]} /></Field>
        <Field label="Campaign"><Suggest disabled={disabled} value={values.campaign} onChange={set('campaign')} options={usedNames(boot, 'campaigns')} /></Field>
        <Field label="Status"><select className="ledger-input" disabled={disabled} value={values.status} onChange={(e) => set('status')(e.target.value)}>
          {(task.entry_kind ? ['Delivered'] : STATUSES).map((s) => <option key={s}>{s}</option>)}</select></Field>
        {['Blocked', 'Awaiting Approval'].includes(values.status) && <Field label="Waiting on"><input className="ledger-input" disabled={disabled} value={values.waiting_on} maxLength={200} onChange={(e) => set('waiting_on')(e.target.value)} /></Field>}
        <Field label="Priority"><select className="ledger-input" disabled={disabled} value={values.priority} onChange={(e) => set('priority')(e.target.value)}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></Field>
        <Field label="Deadline"><input type="date" className="ledger-input" disabled={disabled} value={values.deadline} onChange={(e) => set('deadline')(e.target.value)} /></Field>
        <Field label="Start"><input type="date" className="ledger-input" disabled={disabled} value={values.start_date} onChange={(e) => set('start_date')(e.target.value)} /></Field>
        <Field label="End"><input type="date" className="ledger-input" disabled={disabled} value={values.end_date} onChange={(e) => set('end_date')(e.target.value)} /></Field>
        <Field label="Repeat"><select className="ledger-input" disabled={disabled} value={values.repeat} onChange={(e) => set('repeat')(e.target.value)}>{REPEATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <Field label="Vendor"><Suggest disabled={disabled} value={values.vendor} onChange={set('vendor')} options={usedNames(boot, 'vendors')} /></Field>
        <Field label="Est. cost" hint="₹"><input className="ledger-input" disabled={disabled} inputMode="numeric" value={values.est_cost} onChange={(e) => set('est_cost')(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
        <Field label="Actual cost" hint="₹"><input className="ledger-input" disabled={disabled} inputMode="numeric" value={values.actual_cost} onChange={(e) => set('actual_cost')(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
        <Field label="Tags" wide><input className="ledger-input" disabled={disabled} value={tags ?? (task.tags ?? []).join(', ')} onChange={(e) => setTags(e.target.value)} /></Field>
        <Field label="Outcome" wide><input className="ledger-input" disabled={disabled} value={values.outcome} maxLength={1000} onChange={(e) => set('outcome')(e.target.value)} /></Field>
        <Field label="Depends on" wide><select className="ledger-input" disabled={disabled} value={values.depends_on ?? ''} onChange={(e) => set('depends_on')(e.target.value)}>
          <option value="">Nothing</option>{pending.filter((p) => p.id !== task.id).map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></Field>
        {!disabled && <Field label="Add a note to the history" wide><input className="ledger-input" value={note} maxLength={4000} onChange={(e) => setNote(e.target.value)} /></Field>}
      </div>
      <p className="ledger-quiet">Revision {task.revision}{task.approved_version ? ` · approved: ${task.approved_version}` : ''}{task.status_since ? ` · ${task.status} since ${dateLabel(task.status_since)}` : ''}</p>

      <section className="ledger-editor-part" aria-label="Subtasks">
        <h4>Subtasks</h4>
        <ul className="ledger-checklist">{task.subtasks.map((s) => (
          <li key={s.id}><label><input type="checkbox" disabled={disabled} checked={s.done} onChange={(e) => run('ledger_set_subtask', { _id: s.id, _done: e.target.checked })} /> {s.text}</label>
            {!disabled && <button type="button" className="ledger-icon-button" aria-label={`Remove subtask ${s.text}`} onClick={() => run('ledger_delete_subtask', { _id: s.id })}><Trash2 size={14} /></button>}</li>))}</ul>
        {!disabled && <div className="ledger-row"><input className="ledger-input" aria-label="New subtask" placeholder="Add a step" value={newStep} maxLength={500} onChange={(e) => setNewStep(e.target.value)} />
          <button type="button" className="ledger-button" disabled={!newStep.trim()} onClick={async () => { await run('ledger_add_subtask', { _id: newId(), _task: task.id, _text: newStep.trim() }); setNewStep(''); }}>Add</button></div>}
      </section>

      <section className="ledger-editor-part" aria-label="Deliverables">
        <h4>Deliverables</h4>
        <ul className="ledger-plain-list">{task.deliverables.map((d) => (
          <li key={d.id}>{[d.type, d.version, d.used_where].filter(Boolean).join(' · ')} {d.link && <a href={d.link} target="_blank" rel="noopener noreferrer">open <ExternalLink size={12} /></a>}
            {!disabled && <button type="button" className="ledger-icon-button" aria-label={`Remove deliverable ${d.type ?? ''}`} onClick={() => run('ledger_delete_deliverable', { _id: d.id })}><Trash2 size={14} /></button>}</li>))}</ul>
        {!disabled && <div className="ledger-row">
          {[['type', 'Type'], ['version', 'Version'], ['link', 'Link'], ['used_where', 'Used where']].map(([k, l]) => (
            <input key={k} className="ledger-input" aria-label={l} placeholder={l} value={deliverable[k] ?? ''} onChange={(e) => setDeliverable({ ...deliverable, [k]: e.target.value })} />))}
          <button type="button" className="ledger-button" disabled={!clean(deliverable.type) && !clean(deliverable.link)}
            onClick={async () => { await run('ledger_add_deliverable', { _id: newId(), _task: task.id, _d: deliverable }); setDeliverable({}); }}>Add</button></div>}
      </section>

      <section className="ledger-editor-part" aria-label="Attachments">
        <h4>Files and links</h4>
        <ul className="ledger-plain-list">{task.attachments.map((a) => (
          <li key={a.id}><Paperclip size={13} /> {a.kind === 'link'
            ? <a href={a.url} target="_blank" rel="noopener noreferrer">{a.name}</a>
            : <button type="button" className="ledger-link" onClick={() => openFile(a.storage_path)}>{a.name}</button>}
            {!disabled && <button type="button" className="ledger-icon-button" aria-label={`Remove ${a.name}`} onClick={() => run('ledger_remove_attachment', { _id: a.id })}><Trash2 size={14} /></button>}</li>))}</ul>
        {!disabled && <>
          <div className="ledger-row"><input className="ledger-input" aria-label="Link label" placeholder="Label" value={link.name ?? ''} onChange={(e) => setLink({ ...link, name: e.target.value })} />
            <input className="ledger-input" aria-label="Link address" placeholder="https://…" value={link.url ?? ''} onChange={(e) => setLink({ ...link, url: e.target.value })} />
            <button type="button" className="ledger-button" disabled={!/^https?:\/\//i.test(link.url ?? '')} onClick={async () => { await run('ledger_add_link', { _id: newId(), _task: task.id, _name: link.name ?? null, _url: link.url.trim() }); setLink({}); }}>Add link</button></div>
          <label className="ledger-file"><Paperclip size={14} /> Attach a file
            <input type="file" onChange={async (e) => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
              setError(null); try { await uploadLedgerFile({ owner: boot?.owner?.user_id, taskId: task.id, file }); await detail.refetch(); setSaved('File attached.'); } catch (failure) { setError(failure); } }} /></label>
        </>}
      </section>

      <section className="ledger-editor-part" aria-label="Progress">
        <h4>Progress notes</h4>
        {task.progress.length ? <ul className="ledger-plain-list">{task.progress.map((p) => (
          <li key={p.id}><span className="ledger-date">{dateLabel(p.date)}</span>{p.note}{p.minutes ? <span className="ledger-quiet"> · {p.minutes}m</span> : null}
            {!disabled && <button type="button" className="ledger-icon-button" aria-label="Remove progress note" onClick={() => run('ledger_delete_progress', { _id: p.id })}><Trash2 size={14} /></button>}</li>))}</ul>
          : <p className="ledger-quiet">No progress notes yet.</p>}
      </section>

      {task.notes && <details className="ledger-editor-part"><summary>Notes and history</summary><pre className="ledger-history">{task.notes}</pre></details>}
      {task.brief && typeof task.brief === 'object' && <details className="ledger-editor-part"><summary>Creative brief</summary>
        <dl className="ledger-dl">{Object.entries(task.brief).filter(([, v]) => v).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{String(v)}</dd></div>)}</dl></details>}
      <Message error={error}>{saved}</Message>
      <div className="ledger-actions">
        {!disabled && <button type="submit" className="ledger-button ledger-button-primary" disabled={act.isPending}>Save changes</button>}
        <button type="button" className="ledger-button" onClick={onClose}>Close</button>
        {task.est_cost != null && <span className="ledger-quiet">Est. {money(task.est_cost)}{task.actual_cost != null ? ` · actual ${money(task.actual_cost)}` : ''}</span>}
      </div>
    </form>
  );
}
