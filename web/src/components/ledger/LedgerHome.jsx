// Home: today's numbers, the overdue line, my schedule (reminders + Google Calendar) and my open work
// as a drag-and-drop board or as Task Management's own list. Everything here is my tasks — the ones
// I am on — from the same records the team sees.
import React, { useState } from 'react';
import { AlertTriangle, CalendarClock, Check, Trash2 } from 'lucide-react';
import { connectGoogleCalendar, syncGoogleCalendar, useGoogleEvents } from '../../data/workLedger';
import { useWorkHome, useWorkRpc } from '../../data/work';
import { addDays } from '../../lib/ledger/periods.js';
import { formatMinutes } from '../../lib/ledger/documents.js';
import TaskManagement from '../TaskManagement';
import { btnClass } from '../ui/Btn';
import { TaskBoard } from './Board';
import { Message, istStamp, timeOf, useLedger } from './ui';

const VIEW_KEY = 'parakkat.work.view';
function readView() { try { return globalThis.localStorage?.getItem(VIEW_KEY) === 'list' ? 'list' : 'board'; } catch { return 'board'; } }
function saveView(view) { try { globalThis.localStorage?.setItem(VIEW_KEY, view); } catch { /* private mode */ } }

function Figures({ home }) {
  const items = [
    ['Open', home.pending.length], ['Done today', home.completed_today.length], ['Done this week', home.done_this_week],
    ['Worked on today', home.worked_on_today],
    ['Help today', home.support_today, home.support_minutes_today ? formatMinutes(home.support_minutes_today) : null], ['Overdue', home.overdue],
  ];
  return (
    <dl className="ledger-figures">
      {items.map(([label, value, extra]) => <div key={label}><dt>{label}</dt><dd>{value}{extra && <small> · {extra}</small>}</dd></div>)}
    </dl>
  );
}

function Schedule({ home }) {
  const { open, today } = useLedger();
  const call = useWorkRpc();
  const google = home.google ?? { connected: false, status: 'disconnected' };
  const events = useGoogleEvents(google.connected);
  const [error, setError] = useState(null);
  const tomorrow = addDays(today, 1);
  const run = async (name, args) => {
    setError(null);
    try { await call.mutateAsync({ name, args }); if (google.connected) syncGoogleCalendar().catch(() => {}); }
    catch (failure) { setError(failure); }
  };
  const items = [
    ...(events.data?.events ?? []).map((event) => ({ kind: 'event', id: event.id, at: event.all_day ? `${event.start}T00:00` : istStamp(0, Date.parse(event.start)),
      text: event.summary, allDay: event.all_day, link: event.link })),
    ...(home.schedule ?? []).map((reminder) => ({ kind: 'reminder', id: reminder.id, at: reminder.due_at, text: reminder.text, reminder })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const days = [['Today', items.filter((item) => item.at.slice(0, 10) <= today)], ['Tomorrow', items.filter((item) => item.at.slice(0, 10) === tomorrow)]];
  const needsReconnect = google.status === 'needs_reconnect' || events.data?.reconnect;
  return (
    <section className="ledger-home-block" aria-labelledby="ledger-schedule-title">
      <h3 id="ledger-schedule-title"><CalendarClock size={16} /> Schedule
        <button type="button" className="ledger-link" onClick={() => open('reminder')}>Add a reminder</button></h3>
      {needsReconnect ? <p className="ledger-note">Google Calendar needs reconnecting. Reminders still save here.
        <button type="button" className="ledger-link" onClick={() => connectGoogleCalendar().catch(setError)}>Reconnect</button></p>
        : !google.connected && <p className="ledger-quiet">Google Calendar is not connected, so reminders stay in the app. Connect it in Settings.</p>}
      {events.error && <p className="ledger-quiet">Calendar events could not be loaded just now.</p>}
      {days.map(([label, list]) => (
        <div key={label} className="ledger-schedule-day">
          <h4>{label}</h4>
          {!list.length ? <p className="ledger-quiet">Nothing scheduled.</p> : (
            <ul className="ledger-plain-list">
              {list.map((item) => (
                <li key={`${item.kind}-${item.id}`} className="ledger-schedule-item" data-overdue={item.reminder?.overdue || undefined}>
                  <span className="ledger-time">{item.allDay ? 'All day' : timeOf(item.at)}</span>
                  {item.kind === 'event'
                    ? <span>{item.link ? <a href={item.link} target="_blank" rel="noopener noreferrer">{item.text}</a> : item.text}</span>
                    : <span>{item.text}
                      {item.reminder.task_title && <> · <button type="button" className="ledger-text-button" onClick={() => open('task', item.reminder.task_id)}>{item.reminder.task_title}</button></>}
                      {item.reminder.repeat && <span className="ledger-tag">{item.reminder.repeat}</span>}</span>}
                  {item.kind === 'reminder' && (
                    <span className="ledger-schedule-actions">
                      <button type="button" className="ledger-text-button" onClick={() => run('ledger_complete_reminder', { _id: item.id })}><Check size={12} /> Done</button>
                      {!item.reminder.repeat && (
                        <select className="ledger-move" aria-label={`Snooze ${item.text}`} value="" onChange={(event) => {
                          const value = event.target.value;
                          if (value) run('ledger_snooze_reminder', { _id: item.id, _due_at: value === 'tomorrow' ? `${tomorrow}T09:00` : istStamp(Number(value)) });
                        }}>
                          <option value="">Snooze…</option><option value="15">15 minutes</option><option value="60">1 hour</option><option value="tomorrow">Tomorrow 9:00</option>
                        </select>)}
                      <button type="button" className="ledger-text-button" onClick={() => open('reminder', item.reminder.task_id
                        ? { task_id: item.reminder.task_id, task_title: item.reminder.task_title, text: `Follow up: ${item.text}` }
                        : { text: `Follow up: ${item.text}` })}>Follow-up</button>
                      <button type="button" className={btnClass('subtle', 'sm', true)} aria-label={`Delete reminder ${item.text}`}
                        onClick={() => run('ledger_delete_reminder', { _id: item.id })}><Trash2 size={13} /></button>
                    </span>)}
                </li>
              ))}
            </ul>)}
        </div>
      ))}
      <Message error={error ?? call.error} />
    </section>
  );
}

export default function LedgerHome() {
  const { open } = useLedger();
  const home = useWorkHome();
  const [view, setView] = useState(readView);
  const choose = (next) => { setView(next); saveView(next); };
  if (home.isLoading) return <p className="ledger-quiet">Opening today…</p>;
  if (home.error) return <Message error={home.error} />;
  const data = home.data;
  if (!data.employee_id) {
    return <p className="ledger-empty">The Work Ledger is for staff with an employee record. Your login is not linked to one.</p>;
  }
  return (
    <div className="ledger-home">
      <div className="ledger-big-buttons" aria-label="Quick actions">
        <button type="button" className={btnClass('primary')} onClick={() => open('new-task')}>Add a task</button>
        <button type="button" className={btnClass('ghost')} onClick={() => open('help')}>Log help</button>
        <button type="button" className={btnClass('ghost')} onClick={() => open('tab', 'reports')}>Today’s report</button>
      </div>
      {data.overdue > 0 && (
        <p className="ledger-overdue" role="alert"><AlertTriangle size={15} /> {data.overdue} open task{data.overdue === 1 ? ' is' : 's are'} past the due date.</p>)}
      <Figures home={data} />
      <Schedule home={data} />
      <section className="ledger-home-tasks" aria-labelledby="ledger-tasks-title">
        <div className="ledger-tasks-head">
          <h3 id="ledger-tasks-title">My open work <span className="ledger-count">{data.pending.length}</span></h3>
          <div className="ledger-segmented" role="radiogroup" aria-label="Show tasks as">
            {[['board', 'Board'], ['list', 'List']].map(([id, label]) => (
              <button key={id} type="button" role="radio" aria-checked={view === id} className="ledger-segment" onClick={() => choose(id)}>{label}</button>))}
          </div>
        </div>
        {view === 'board'
          ? (data.pending.length ? <TaskBoard tasks={data.pending} onOpen={(id) => open('task', id)} />
            : <p className="ledger-empty">Nothing open. Press N to add a task.</p>)
          : <TaskManagement embedded embeddedView="todo" />}
        {data.completed_today.length > 0 && (
          <div className="ledger-section">
            <h3>Done today <span className="ledger-count">{data.completed_today.length}</span></h3>
            <ul className="ledger-list ledger-list-compact">{data.completed_today.map((task) => (
              <li key={task.id}><button type="button" className="ledger-text-button ledger-item-title" onClick={() => open('task', task.id)}>{task.title}</button>
                {task.outcome && <span className="ledger-quiet"> — {task.outcome}</span>}</li>))}</ul>
          </div>)}
      </section>
    </div>
  );
}
