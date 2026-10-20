// While the ledger is open: a banner (and a chime, if sound is on) when a reminder falls due and
// ten minutes before a Calendar meeting. Checked every 30 seconds from the data already loaded.
import React, { useEffect, useRef, useState } from 'react';
import { BellRing, X } from 'lucide-react';
import { syncGoogleCalendar, useGoogleEvents } from '../../data/workLedger';
import { useWorkRpc } from '../../data/work';
import { chime, istStamp, timeOf } from './ui';
import { btnClass } from '../ui/Btn';

const SEEN_KEY = 'parakkat.ledger.announced';
function loadSeen() { try { return new Set(JSON.parse(globalThis.sessionStorage?.getItem(SEEN_KEY) ?? '[]')); } catch { return new Set(); } }
function saveSeen(seen) { try { globalThis.sessionStorage?.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-200))); } catch { /* private mode */ } }

/** What is due now: reminders at or past their time, meetings starting within ten minutes. */
export function dueItems({ schedule = [], events = [], now = Date.now() }) {
  const stamp = istStamp(0, now);
  const reminders = schedule.filter((reminder) => !reminder.done && reminder.due_at <= stamp)
    .map((reminder) => ({ key: `r:${reminder.id}:${reminder.due_at}`, id: reminder.id, kind: 'reminder', text: reminder.text, at: reminder.due_at }));
  const meetings = events.filter((event) => !event.all_day).map((event) => ({ event, start: Date.parse(event.start) }))
    .filter(({ start }) => start > now && start - now <= 10 * 60_000)
    .map(({ event, start }) => ({ key: `e:${event.id}:${event.start}`, kind: 'meeting', text: event.summary, at: istStamp(0, start), minutes: Math.ceil((start - now) / 60_000) }));
  return [...meetings, ...reminders];
}

export default function DueBanner({ home, sound }) {
  const act = useWorkRpc();
  const connected = Boolean(home?.google?.connected);
  const events = useGoogleEvents(connected);
  const [items, setItems] = useState([]);
  const seen = useRef(null);
  const latest = useRef({});
  latest.current = { schedule: home?.schedule ?? [], events: events.data?.events ?? [], sound };

  useEffect(() => {
    seen.current ??= loadSeen();
    const check = () => {
      const fresh = dueItems(latest.current).filter((item) => !seen.current.has(item.key));
      if (!fresh.length) return;
      fresh.forEach((item) => seen.current.add(item.key));
      saveSeen(seen.current);
      setItems((current) => [...current, ...fresh].slice(-4));
      if (latest.current.sound) chime();
    };
    check();
    const timer = setInterval(check, 30_000);
    return () => clearInterval(timer);
  }, []);

  if (!items.length) return null;
  const dismiss = (key) => setItems((current) => current.filter((item) => item.key !== key));
  return (
    <div className="ledger-due" role="status" aria-live="assertive">
      {items.map((item) => (
        <p key={item.key} className="ledger-due-item">
          <BellRing size={15} aria-hidden="true" />
          <span>{item.kind === 'meeting' ? `In ${item.minutes} min: ${item.text}` : `Reminder: ${item.text}`} <span className="ledger-quiet">{timeOf(item.at)}</span></span>
          {item.kind === 'reminder' && <button type="button" className="ledger-text-button" onClick={async () => {
            dismiss(item.key);
            try { await act.mutateAsync({ name: 'ledger_complete_reminder', args: { _id: item.id } }); if (connected) syncGoogleCalendar().catch(() => {}); } catch { /* stays in Schedule */ }
          }}>Done</button>}
          <button type="button" className={btnClass('subtle', 'sm', true)} aria-label="Dismiss" onClick={() => dismiss(item.key)}><X size={14} /></button>
        </p>
      ))}
    </div>
  );
}
