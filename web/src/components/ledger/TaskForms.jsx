// The Work Ledger's forms, all writing Task Management's own records:
//   NewTaskPanel — the same composer Task Management uses (people, subtasks, files), inline;
//   TaskDrawer — one task opened from the board or quick add: its ledger parts, subtasks, thread, edit;
//   LogHelpDrawer — help given to colleagues (task_help_log);
//   ReminderDrawer — a reminder, mirrored to Google Calendar when connected.
import React, { useState } from 'react';
import { PenLine } from 'lucide-react';
import { useAuth } from '../../auth/AuthContext';
import { usePermissions } from '../../auth/usePermissions';
import { useEmployees } from '../../data/employees';
import { useAddAssignee, useCreateTask, useRemoveAssignee, useTasks, useUpdateTask } from '../../data/tasks';
import { newId, syncGoogleCalendar } from '../../data/googleCalendar';
import { useWorkRpc, useWorkTask, useWorkUpdate, useWorkWrite } from '../../data/work';
import { useCreativeLibrary, useCreativeWrite } from '../../data/creative';
import { humanDbError } from '../../lib/dbErrors';
import { istToday } from '../../lib/dates';
import { assigneeIds } from '../../lib/taskBoard';
import { TaskComposer } from '../TaskManagement';
import TaskDetail from '../TaskDetail';
import { btnClass } from '../ui/Btn';
import Drawer from './Drawer';
import { Field, Message, StatusPill, Suggest, dateLabel, useLedger } from './ui';

import SearchSelect from '../ui/SearchSelect';
const REPEATS = [['', 'None'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['weekdays', 'Mon–Fri'], ['monthly', 'Monthly']];
const scopeOf = (e) => ({ entityId: e.entity_id, zoneId: e.zone_id, branchId: e.branch_id, deptId: e.department_id, employeeId: e.id });

/**
 * N — a new task, for yourself or (if your role allows) for others, with subtasks and files.
 * `preset` starts it from somewhere: { title, description, steps, patch (brand, campaign…), ideaId, note }.
 * The creative team can also start from one of their templates (its subtasks and work type).
 */
export function NewTaskPanel({ preset = {}, onClose, onCreated }) {
  const { employee } = useAuth();
  const { can } = usePermissions();
  const { creative } = useLedger();
  const { data: employees = [] } = useEmployees();
  const library = useCreativeLibrary({ enabled: creative });
  const create = useCreateTask();
  const update = useWorkUpdate();
  const creativeWrite = useCreativeWrite();
  const [saving, setSaving] = useState(false);
  const [templateId, setTemplateId] = useState('');
  const templates = creative ? library.data?.templates ?? [] : [];
  const template = templates.find((t) => t.id === templateId);
  const initial = { title: preset.title, description: preset.description, steps: template?.subtasks ?? preset.steps };
  // Fields Task Management's composer does not have, set on the new task straight after it is made.
  const finish = async (taskId) => {
    const patch = { ...(preset.patch ?? {}), ...(template?.type ? { work_type: template.type } : {}) };
    const clean = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== null && value !== undefined && value !== ''));
    if (Object.keys(clean).length) await update.mutateAsync({ id: taskId, patch: clean }).catch(() => {});
    if (preset.ideaId) await creativeWrite.mutateAsync({ op: 'idea', id: preset.ideaId, task_id: taskId, status: 'Promoted' }).catch(() => {});
  };
  return (
    <section className="ledger-new-task" aria-label="New task">
      {(preset.note || templates.length > 0) && (
        <div className="ledger-new-task-start">
          {preset.note && <p className="ledger-quiet">{preset.note}</p>}
          {templates.length > 0 && (
            <label className="ledger-field ledger-template-pick"><span>Start from a template</span>
              <SearchSelect className="ledger-input" value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
                <option value="">No template</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.subtasks?.length ? ` · ${t.subtasks.length} subtasks` : ''}</option>)}
              </SearchSelect></label>)}
        </div>)}
      <TaskComposer
        key={templateId || 'blank'}
        initial={initial}
        employees={employees}
        canAssignTo={(e) => e.id === employee?.id || can('task.create', scopeOf(e))}
        currentEmployeeId={employee?.id}
        task={null}
        defaultAssignee={employee?.id}
        busy={saving || create.isPending}
        createdTaskId={create.error?.createdTaskId}
        error={humanDbError(create.error, 'tasks')}
        onClose={() => { if (!saving) { create.reset(); onClose(); } }}
        onSubmit={async (payload) => {
          setSaving(true);
          try { const created = await create.mutateAsync(payload); await finish(created.id); onCreated?.(created.id); onClose(); }
          catch { /* shown in the composer */ }
          finally { setSaving(false); }
        }}
      />
    </section>
  );
}

/** One task, opened from the board, quick add or a reminder. */
export function TaskDrawer({ taskId, onClose, onRemind }) {
  const { employee } = useAuth();
  const { can } = usePermissions();
  const { data: employees = [] } = useEmployees();
  const work = useWorkTask(taskId);
  const tasks = useTasks();
  const edit = useUpdateTask();
  const addAssignee = useAddAssignee();
  const removeAssignee = useRemoveAssignee();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const card = work.data;
  // Task Management's own row (people, checklist counts) when it is loaded; the card otherwise.
  const row = tasks.data?.find((t) => t.id === taskId) ?? (card ? { ...card, assignees: undefined } : null);
  const scope = row ? { entityId: row.entity_id, zoneId: row.zone_id, branchId: row.branch_id, deptId: row.department_id, employeeId: row.employee_id } : {};
  const canEdit = row && (can('task.update', scope) || can('task.manage', scope));
  const canReassign = row && can('task.manage', scope);
  const syncPeople = async (task, wanted) => {
    const had = assigneeIds(task);
    for (const id of had) if (!wanted.includes(id)) await removeAssignee.mutateAsync({ taskId: task.id, employeeId: id, primaryId: wanted[0] });
    for (const id of wanted) if (!had.includes(id)) await addAssignee.mutateAsync({ taskId: task.id, employeeId: id, addedBy: employee?.id ?? null });
  };
  return (
    <Drawer title={card?.title ?? 'Task'} subtitle={card ? [card.step, card.assignee_name, card.due_date ? `due ${dateLabel(card.due_date)}` : null].filter(Boolean).join(' · ') : ''}
      onClose={onClose} wide>
      {work.isLoading && <p className="ledger-quiet">Opening…</p>}
      {work.error && <Message error={work.error} />}
      {card && row && (editing ? (
        <TaskComposer
          employees={employees}
          canAssignTo={(e) => can('task.update', scopeOf(e)) || can('task.manage', scopeOf(e))}
          currentEmployeeId={employee?.id}
          task={row}
          canReassign={Boolean(canReassign)}
          busy={saving}
          error={humanDbError(edit.error || addAssignee.error || removeAssignee.error, 'tasks')}
          onClose={() => setEditing(false)}
          onSubmit={async ({ assigneeIds: wanted = [], ...fields }) => {
            setSaving(true);
            try { await edit.mutateAsync({ id: row.id, ...fields }); await syncPeople(row, wanted); setEditing(false); }
            catch { /* shown in the composer */ }
            finally { setSaving(false); }
          }}
        />
      ) : (
        <div className="ledger-task-drawer">
          <div className="ledger-task-summary">
            <StatusPill status={card.step} />
            {card.priority && <span className="ledger-quiet">{card.priority} priority</span>}
            {card.assigner_name && <span className="ledger-quiet">Assigned by {card.assigner_name}</span>}
            {canEdit && <button type="button" className={btnClass('ghost', 'sm')} onClick={() => setEditing(true)}><PenLine size={13} /> Edit</button>}
          </div>
          {card.description && <p className="ledger-task-description">{card.description}</p>}
          <TaskDetail task={row} open onRemind={onRemind} />
        </div>
      ))}
    </Drawer>
  );
}

/** H — help or a review given to a colleague. Counts in reports; never a task on a board. */
export function LogHelpDrawer({ initial = {}, onClose }) {
  const { today } = useLedger();
  const { data: employees = [] } = useEmployees();
  const write = useWorkWrite();
  const [form, setForm] = useState({ kind: 'Review / Feedback', date: today || istToday(), ...initial });
  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }));
  const submit = (event) => {
    event.preventDefault();
    if (!form.what?.trim()) return;
    write.mutate({ op: 'help', what: form.what.trim(), for_whom: form.for_whom?.trim(), minutes: Number(form.minutes) || null,
      kind: form.kind, date: form.date, note: form.note?.trim(), taskId: form.taskId }, { onSuccess: onClose });
  };
  return (
    <Drawer title="Log help or a review" subtitle="Counts under Support & reviews in your reports" onClose={onClose} initialFocus="#ledger-help-what"
      footer={<button type="submit" form="ledger-help" className={btnClass('primary')} disabled={write.isPending || !form.what?.trim()}>Save</button>}>
      <form id="ledger-help" className="ledger-form" onSubmit={submit}>
        <Field label="What you did" wide><input id="ledger-help-what" className="ledger-input" required maxLength={500} value={form.what ?? ''} onChange={(e) => set('what')(e.target.value)} /></Field>
        <Field label="For whom"><Suggest value={form.for_whom} onChange={set('for_whom')} options={employees.map((e) => e.full_name)} maxLength={120} /></Field>
        <Field label="Minutes"><input className="ledger-input" inputMode="numeric" value={form.minutes ?? ''} onChange={(e) => set('minutes')(e.target.value.replace(/\D/g, ''))} /></Field>
        <Field label="Type"><select className="ledger-input" value={form.kind} onChange={(e) => set('kind')(e.target.value)}>
          <option>Review / Feedback</option><option>Team support</option></select></Field>
        <Field label="Day"><input type="date" className="ledger-input" value={form.date} max={istToday()} onChange={(e) => set('date')(e.target.value)} /></Field>
        <Field label="Notes" wide><textarea className="ledger-input" rows={2} value={form.note ?? ''} onChange={(e) => set('note')(e.target.value)} /></Field>
        <Message error={write.error} />
      </form>
    </Drawer>
  );
}

/** R — a reminder. With a task it is a follow-up on that task. */
export function ReminderDrawer({ initial = {}, onClose }) {
  const { today } = useLedger();
  const call = useWorkRpc();
  const [form, setForm] = useState({ date: today || istToday(), time: '09:00', repeat: '', ...initial });
  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event) => {
    event.preventDefault();
    if (!form.text?.trim()) return;
    try {
      const saved = await call.mutateAsync({ name: 'ledger_add_reminder', args: { _id: newId(), _r: {
        text: form.text.trim(), due_at: `${form.date}T${form.time}`, repeat: form.repeat || null, task_id: initial.task_id ?? null,
        source: initial.task_id ? 'followup' : 'reminder' } } });
      if (saved?.calendar) await syncGoogleCalendar().catch(() => {});
      onClose();
    } catch { /* shown below */ }
  };
  return (
    <Drawer title={initial.task_id ? 'Follow-up' : 'Reminder'} subtitle={initial.task_title} onClose={onClose} initialFocus="#ledger-reminder-text"
      footer={<button type="submit" form="ledger-reminder" className={btnClass('primary')} disabled={call.isPending}>Save reminder</button>}>
      <form id="ledger-reminder" className="ledger-form" onSubmit={submit}>
        <Field label="Remind me to" wide><input id="ledger-reminder-text" className="ledger-input" required maxLength={500} value={form.text ?? ''} onChange={(e) => set('text')(e.target.value)} /></Field>
        <Field label="Day"><input type="date" className="ledger-input" required value={form.date} onChange={(e) => set('date')(e.target.value)} /></Field>
        <Field label="Time"><input type="time" className="ledger-input" required value={form.time} onChange={(e) => set('time')(e.target.value)} /></Field>
        <Field label="Repeat"><select className="ledger-input" value={form.repeat} onChange={(e) => set('repeat')(e.target.value)}>{REPEATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <p className="ledger-quiet ledger-form-wide">If Google Calendar is connected (Settings), this becomes a calendar event with pop-ups at the time and 10 minutes before.</p>
        <Message error={call.error} />
      </form>
    </Drawer>
  );
}
