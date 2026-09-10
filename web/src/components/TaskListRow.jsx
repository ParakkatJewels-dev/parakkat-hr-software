import React from 'react';
import { Check, Circle, ListTodo, MessageSquare, Paperclip, CalendarDays, Flag, ChevronDown, PenLine, Trash2 } from 'lucide-react';
import { assigneesOf, isOverdue } from '../lib/taskBoard';
import { checklistProgress } from '../lib/checklist';
import { messageLinkParts } from '../lib/messageLinks';
import { initialsOf } from './ui/Avatar';

const STATUS = ['To Do', 'In Progress', 'Blocked', 'Done', 'Cancelled'];
const DATE = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const tone = (value) => (value || '').toLowerCase().replaceAll(' ', '-');

export function TaskListColumns() {
  return <div className="work-list-columns" aria-hidden="true"><span>Task</span><span>Assignee</span><span>Due date</span><span>Status</span><span /></div>;
}

/** A single readable row, shared by the team list and an employee's own work. */
export default function TaskListRow({ task, actions, children }) {
  const open = actions.openDetail === task.id;
  const steps = checklistProgress(task.checklist ?? []);
  const overdue = isOverdue(task, actions.today);
  const done = task.status === 'Done';
  const canUpdate = actions.canUpdate(task);
  const people = assigneesOf(task);
  const primary = people[0]?.employee?.full_name || task.assignee?.full_name || 'Assignee not visible';
  const names = people.map((p) => p.employee?.full_name || 'Assignee not visible');
  const blockedBySteps = steps.total > 0 && !steps.allDone;
  const toggle = () => actions.toggleDetail(task.id);
  const completeLabel = blockedBySteps
    ? `Open subtasks to complete ${task.title}`
    : `${done ? 'Reopen' : 'Complete'} ${task.title}`;
  const detailId = `task-detail-${task.id}`;
  const comments = actions.commentCounts?.[task.id] || 0;
  const files = actions.attachmentCounts?.[task.id] || 0;
  const date = task.due_date ? DATE.format(new Date(`${task.due_date.slice(0, 10)}T00:00:00Z`)) : 'No due date';

  return (
    <article {...actions.rowProps?.(task.id)} className={`work-row ${open ? 'work-row-open' : ''}`} role="listitem" data-status={tone(task.status)}>
      <div className="work-row-grid">
        <div className="work-row-content">
          <button type="button" className="work-complete" disabled={!canUpdate || actions.busy || task.status === 'Cancelled'}
            aria-label={completeLabel} title={completeLabel}
            onClick={() => blockedBySteps ? toggle() : actions.setStatus(task.id, done ? 'In Progress' : 'Done')}>
            {done ? <Check size={15} /> : <Circle size={19} />}
          </button>
          <div className="work-row-copy">
            <h3><button type="button" className="work-title" onClick={toggle} aria-expanded={open} aria-controls={detailId}>{task.title}</button></h3>
            {task.description && <p className="work-description">{messageLinkParts(task.description).map((part, index) => part.type === 'link'
              ? <a key={index} href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a>
              : <React.Fragment key={index}>{part.text}</React.Fragment>)}</p>}
            <div className="work-row-meta">
              <span className="work-priority" data-priority={tone(task.priority)}><Flag size={12} />{task.priority}</span>
              {steps.total > 0 && <button type="button" onClick={toggle} aria-label={`${steps.done} of ${steps.total} subtasks complete. Open ${task.title}`}>
                <ListTodo size={13} />{steps.done}/{steps.total} subtasks
              </button>}
              {comments > 0 && <button type="button" onClick={toggle} aria-label={`${comments} messages. Open ${task.title}`}><MessageSquare size={12} />{comments}</button>}
              {files > 0 && <button type="button" onClick={toggle} aria-label={`${files} attachments. Open ${task.title}`}><Paperclip size={12} />{files}</button>}
              {overdue && <span className="work-overdue">Overdue</span>}
            </div>
          </div>
        </div>
        <div className="work-row-person" title={names.join(', ') || primary}>
          <span className="work-avatar" aria-hidden="true">{initialsOf(primary)}</span><span>{primary}</span>
          {people.length > 1 && <small>+{people.length - 1}</small>}
        </div>
        <div className={`work-row-date ${overdue ? 'work-overdue' : ''}`}><CalendarDays size={13} /><span>{task.due_date?.slice(0, 10) === actions.today ? 'Today' : date}</span></div>
        <label className="work-status" data-status={tone(task.status)}>
          <span className="work-status-dot" aria-hidden="true" />
          {canUpdate ? <select aria-label={`Status of ${task.title}`} value={task.status} disabled={actions.busy}
            onChange={(event) => actions.setStatus(task.id, event.target.value)}>
            {STATUS.filter((s) => s === task.status || s !== 'Done' || !blockedBySteps).map((s) => <option key={s}>{s}</option>)}
          </select> : <span>{task.status}</span>}
        </label>
        <button type="button" className="work-expand" onClick={toggle} aria-expanded={open} aria-controls={detailId} aria-label={`${open ? 'Close' : 'Open'} ${task.title}`}><ChevronDown size={16} /></button>
      </div>
      <div id={detailId} className="work-row-details" hidden={!open}>
        {open && <>
          <div className="work-detail-toolbar">
            <div>
              <span className="work-detail-label">People on this task</span>
              <span>{names.join(', ') || primary}</span>
              {task.assigner?.full_name && <small>Assigned by {task.assigner.full_name}</small>}
              {(task.assignee?.branch?.code || task.assignee?.department?.name) && <small>{[task.assignee?.branch?.code, task.assignee?.department?.name].filter(Boolean).join(' · ')}</small>}
            </div>
            <div className="work-detail-actions">
              {actions.canEdit?.(task) && <button type="button" className="work-button" onClick={() => actions.edit(task)}><PenLine size={13} />Edit task</button>}
              {actions.canManage?.(task) && <button type="button" className="work-button work-delete" onClick={() => actions.remove(task)}><Trash2 size={13} />Delete</button>}
            </div>
          </div>
          {children}
        </>}
      </div>
    </article>
  );
}
