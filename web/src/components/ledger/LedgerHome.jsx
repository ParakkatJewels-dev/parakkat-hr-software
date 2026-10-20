// Home (Today): overdue line, the day's figures, alerts, schedule, campaigns, ideas and the board.
import React, { useState } from 'react';
import { AlertTriangle, CalendarClock, Check, Lightbulb, Plus, Trash2 } from 'lucide-react';
import { connectGoogleCalendar, newId, syncGoogleCalendar, useGoogleEvents, useLedgerAction, useLedgerHome } from '../../data/workLedger';
import { parseQuickCapture } from '../../lib/ledger/quickCapture.js';
import { addDays } from '../../lib/ledger/periods.js';
import { formatMinutes } from '../../lib/ledger/documents.js';
import { TaskBoard, TaskList } from './Board';
import { BrandMark, Message, dateLabel, errorText, istStamp, money, timeOf, useLedger } from './ui';
import { btnClass } from '../ui/Btn';

const VIEW_KEY = 'parakkat.ledger.view';
function readView() { try { return globalThis.localStorage?.getItem(VIEW_KEY) === 'list' ? 'list' : 'board'; } catch { return 'board'; } }
function saveView(view) { try { globalThis.localStorage?.setItem(VIEW_KEY, view); } catch { /* private mode */ } }

function Figures({ home }) {
  const items = [
    ['Pending', home.pending.length], ['Delivered today', home.completed_today.length], ['Done this week', home.done_this_week],
    ['Worked on today', home.worked_on_today],
    ['Help today', home.support_today, home.support_minutes_today ? formatMinutes(home.support_minutes_today) : null], ['Ideas open', home.ideas_open],
  ];
  return (
    <dl className="ledger-figures">
      {items.map(([label, value, extra]) => <div key={label}><dt>{label}</dt><dd>{value}{extra && <small> · {extra}</small>}</dd></div>)}
    </dl>
  );
}

const ALERT_LABELS = { decision: 'Decision needed', blocked: 'Blocked', launch: 'Launch', review: 'Review', milestone: 'Milestone', idea: 'Revisit idea' };
function Alerts({ alerts }) {
  const { open } = useLedger();
  if (!alerts.length) return null;
  return (
    <section className="ledger-home-block" aria-labelledby="ledger-alerts-title">
      <h3 id="ledger-alerts-title">Needs attention <span className="ledger-count">{alerts.length}</span></h3>
      <ul className="ledger-plain-list ledger-alerts">
        {alerts.map((alert, index) => (
          <li key={`${alert.kind}-${alert.campaign_id ?? alert.idea_id}-${index}`}>
            <span className="ledger-alert-kind" data-kind={alert.kind}>{ALERT_LABELS[alert.kind] ?? alert.kind}</span>
            <button type="button" className="ledger-text-button" onClick={() => (alert.idea_id ? open('idea', alert.idea_id) : open('campaign', alert.campaign_id))}>{alert.title}</button>
            <span className="ledger-quiet"> — {alert.text}{alert.date ? ` (${dateLabel(alert.date)})` : ''}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Schedule({ home }) {
  const { open, today } = useLedger();
  const act = useLedgerAction();
  const google = home.google ?? { connected: false, status: 'disconnected' };
  const events = useGoogleEvents(google.connected);
  const [error, setError] = useState(null);
  const tomorrow = addDays(today, 1);
  const run = async (name, args) => {
    setError(null);
    try { await act.mutateAsync({ name, args }); if (google.connected) syncGoogleCalendar().catch(() => {}); }
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
                    : <span>{item.text}{item.reminder.task_title && <span className="ledger-quiet"> · {item.reminder.task_title}</span>}
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
                        ? { followUp: true, task_id: item.reminder.task_id, task_title: item.reminder.task_title, text: `Follow up: ${item.text}` }
                        : { text: `Follow up: ${item.text}` })}>Follow-up</button>
                      <button type="button" className={btnClass('subtle', 'sm', true)} aria-label={`Delete reminder ${item.text}`}
                        onClick={() => run('ledger_delete_reminder', { _id: item.id })}><Trash2 size={13} /></button>
                    </span>)}
                </li>
              ))}
            </ul>)}
        </div>
      ))}
      <Message error={error ?? act.error} />
    </section>
  );
}

function Campaigns({ campaigns, keyDates }) {
  const { open, readOnly } = useLedger();
  const suggestions = keyDates.filter((date) => !date.has_campaign).slice(0, 4);
  return (
    <section className="ledger-home-block" aria-labelledby="ledger-campaigns-title">
      <h3 id="ledger-campaigns-title">Campaigns <span className="ledger-count">{campaigns.length}</span>
        {!readOnly && <button type="button" className="ledger-link" onClick={() => open('campaign', 'new')}>Set up campaign</button>}</h3>
      {campaigns.length ? (
        <table className="ledger-table ledger-campaign-table">
          <thead><tr><th>Campaign</th><th>Stage</th><th>Done</th><th>Review · blocked</th><th>Spend</th><th>Launch</th></tr></thead>
          <tbody>{campaigns.map((campaign) => (
            <tr key={campaign.id}>
              <td><button type="button" className="ledger-text-button" onClick={() => open('campaign', campaign.id)}>{campaign.name}</button> <BrandMark label={campaign.brand_label} /></td>
              <td>{campaign.stage}</td><td>{campaign.done}/{campaign.total}</td><td>{campaign.in_review} · {campaign.blocked}</td>
              <td>{campaign.spend ? money(campaign.spend) : '—'}</td>
              <td>{campaign.launch_date ? (campaign.days_to_launch < 0 ? `${dateLabel(campaign.launch_date)} (passed)` : `${dateLabel(campaign.launch_date)} · ${campaign.days_to_launch}d`) : '—'}</td>
            </tr>))}</tbody>
        </table>) : <p className="ledger-quiet">No active campaigns.</p>}
      {suggestions.length > 0 && (
        <div className="ledger-suggestions">
          <h4>Coming up without a campaign</h4>
          <ul className="ledger-plain-list">{suggestions.map((date) => (
            <li key={date.id}><span className="ledger-date">{dateLabel(date.date)}</span>{date.name}<span className="ledger-quiet"> · in {date.days_away} days</span>
              {!readOnly && <button type="button" className="ledger-link" onClick={() => open('campaign', { new: true, name: date.name, launch_date: date.date, brand: date.brand })}>
                Set up campaign</button>}</li>))}</ul>
        </div>)}
    </section>
  );
}

function Ideas({ ideas }) {
  const { open, readOnly, today } = useLedger();
  const act = useLedgerAction();
  const [text, setText] = useState('');
  const add = async (event) => {
    event.preventDefault();
    const parsed = parseQuickCapture(`idea: ${text}`, { today });
    if (!parsed.text) return;
    await act.mutateAsync({ name: 'ledger_add_idea', args: { _id: newId(), _text: parsed.text, _brand: parsed.brand ?? null, _tags: parsed.tags ?? [] } });
    setText('');
  };
  return (
    <section className="ledger-home-block" aria-labelledby="ledger-ideas-title">
      <h3 id="ledger-ideas-title"><Lightbulb size={16} /> Latest ideas
        <button type="button" className="ledger-link" onClick={() => open('tab', 'ideas')}>All ideas</button></h3>
      {!readOnly && (
        <form className="ledger-inline-form" onSubmit={add}>
          <input className="ledger-input" aria-label="New idea" placeholder="An idea… use @jewels and #tags" value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} />
          <button type="submit" className={btnClass('ghost')} disabled={!text.trim() || act.isPending}><Plus size={14} /> Add</button>
        </form>)}
      {act.error && <p className="ledger-alert-inline" role="alert">{errorText(act.error)}</p>}
      {ideas.length ? <ul className="ledger-plain-list">{ideas.map((idea) => (
        <li key={idea.id}><button type="button" className="ledger-text-button ledger-idea-line" onClick={() => open('idea', idea.id)}>{idea.text}</button>
          {idea.status === 'Developing' && <span className="ledger-tag">Developing</span>}</li>))}</ul>
        : <p className="ledger-quiet">No open ideas.</p>}
    </section>
  );
}

export default function LedgerHome() {
  const { owner, readOnly, open } = useLedger();
  const home = useLedgerHome(owner);
  const [view, setView] = useState(readView);
  const [overdue, setOverdue] = useState({ on: false, round: 0 });
  const choose = (next) => { setView(next); saveView(next); };
  if (home.isLoading) return <p className="ledger-quiet">Opening today…</p>;
  if (home.error) return <Message error={home.error} />;
  const data = home.data;
  return (
    <div className="ledger-home">
      {!readOnly && (
        <div className="ledger-big-buttons" aria-label="Quick actions">
          <button type="button" className={btnClass('primary')} onClick={() => open('task')}>Add a task</button>
          <button type="button" className={btnClass('ghost')} onClick={() => open('help')}>Log help</button>
          <button type="button" className={btnClass('ghost')} onClick={() => open('tab', 'reports')}>Today’s report</button>
        </div>)}
      {data.overdue > 0 && (
        <p className="ledger-overdue" role="alert"><AlertTriangle size={15} /> {data.overdue} open task{data.overdue === 1 ? ' is' : 's are'} past the deadline.
          <button type="button" className="ledger-link" onClick={() => { setOverdue((current) => ({ on: true, round: current.round + 1 })); choose('list'); }}>Show them</button></p>)}
      <Figures home={data} />
      <div className="ledger-home-columns">
        <div>
          <Alerts alerts={data.alerts} />
          <Campaigns campaigns={data.campaigns} keyDates={data.key_dates} />
        </div>
        <div>
          {data.schedule && <Schedule home={data} />}
          <Ideas ideas={data.ideas} />
        </div>
      </div>
      <section className="ledger-home-tasks" aria-labelledby="ledger-tasks-title">
        <div className="ledger-tasks-head">
          <h3 id="ledger-tasks-title">Pending <span className="ledger-count">{data.pending.length}</span></h3>
          <div className="ledger-segmented" role="radiogroup" aria-label="Show tasks as">
            {[['board', 'Board'], ['list', 'List']].map(([id, label]) => (
              <button key={id} type="button" role="radio" aria-checked={view === id} className="ledger-segment" onClick={() => choose(id)}>{label}</button>))}
          </div>
        </div>
        {view === 'board' ? <TaskBoard pending={data.pending} />
          : <TaskList key={overdue.round} pending={data.pending} initialFilters={{ overdue: overdue.on }} />}
        {data.completed_today.length > 0 && (
          <div className="ledger-section">
            <h3>Delivered today <span className="ledger-count">{data.completed_today.length}</span></h3>
            <ul className="ledger-list ledger-list-compact">{data.completed_today.map((task) => (
              <li key={task.id}><span className="ledger-item-title">{task.title}</span> <span className="ledger-brand">{task.brand_label}</span>
                {task.outcome && <span className="ledger-quiet"> — {task.outcome}</span>}</li>))}</ul>
          </div>)}
      </section>
    </div>
  );
}
