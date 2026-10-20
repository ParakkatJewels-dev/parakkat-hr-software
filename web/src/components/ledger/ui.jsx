// Small building blocks shared by the Work Ledger panels. Plain, typographic, hairline-ruled.
import React, { createContext, useContext, useId } from 'react';
import { humanDbError } from '../../lib/dbErrors';
import { longDate, shortDate } from '../../lib/ledger/periods.js';

/** Who is signed in, today's date (India time), what they may do, and how to open the shared panels. */
export const LedgerContext = createContext({ employeeId: null, today: '', canTeam: false, creative: false, open: () => {} });
export const useLedger = () => useContext(LedgerContext);

export const STATUSES = ['Brief', 'In Progress', 'Internal Review', 'Awaiting Approval', 'Revisions', 'Approved', 'Delivered', 'Blocked', 'Cancelled'];
export const OPEN_STATUSES = STATUSES.filter((status) => !['Delivered', 'Cancelled'].includes(status));
export const PRIORITIES = ['High', 'Medium', 'Low'];
export const REPEATS = [['', 'None'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['weekdays', 'Mon–Fri'], ['monthly', 'Monthly']];
export const WORK_TYPES = ['Print', 'Social', 'Reel', 'Photography', 'Video', 'Ads', 'Website', 'Packaging', 'Event', 'Review / Feedback'];
export const STAGES = ['Captured', 'Developing', 'Decision', 'Approved', 'Production', 'Live', 'Reviewed'];
export const errorText = (error, fallback = 'That did not work. Try again.') => (error ? humanDbError(error) || fallback : '');

export function Field({ label, hint, children, wide = false }) {
  const id = useId();
  const child = React.isValidElement(children) ? React.cloneElement(children, { id: children.props.id ?? id }) : children;
  return (
    <label className="ledger-field" data-wide={wide || undefined} htmlFor={child?.props?.id ?? id}>
      <span>{label}{hint && <small> · {hint}</small>}</span>
      {child}
    </label>
  );
}

/** A text input that suggests values already used in the ledger, but accepts anything. */
export function Suggest({ value, onChange, options = [], placeholder, id, maxLength = 160, ...rest }) {
  const listId = useId();
  return (
    <>
      <input id={id} className="ledger-input" value={value ?? ''} list={listId} placeholder={placeholder} maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)} {...rest} />
      <datalist id={listId}>{[...new Set(options.filter(Boolean))].map((option) => <option key={option} value={option} />)}</datalist>
    </>
  );
}

export function Message({ error, children, tone = 'quiet' }) {
  if (error) return <p className="ledger-alert" role="alert">{errorText(error)}</p>;
  if (!children) return null;
  return <p className={tone === 'note' ? 'ledger-note' : 'ledger-quiet'} role="status">{children}</p>;
}

export function StatusPill({ status }) {
  return <span className="ledger-status" data-status={status}>{status}</span>;
}

export function BrandMark({ label }) {
  return label ? <span className="ledger-brand-mark" data-brand={label}>{label}</span> : null;
}

export const dateLabel = (value) => (value ? shortDate(String(value).slice(0, 10)) : '');
export const fullDate = (value) => (value ? longDate(String(value).slice(0, 10)) : '');
export const money = (value) => (value == null || value === '' ? '' : `₹${Math.round(Number(value)).toLocaleString('en-IN')}`);

/** Brand order on Home: the person's brands as sorted in their ledger, then anything else A–Z. */
export function brandRank(boot) {
  const order = new Map((boot?.brands ?? []).map((brand, index) => [brand.name.toLowerCase(), index]));
  return (name) => order.get(String(name ?? '').toLowerCase()) ?? 1000;
}


/** 'YYYY-MM-DDTHH:MM' in India time, `minutes` from now — the format reminder RPCs take. */
export function istStamp(minutes = 0, now = Date.now()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now + minutes * 60_000)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
export const timeOf = (stamp) => {
  const [h, m] = String(stamp ?? '').slice(11, 16).split(':').map(Number);
  return Number.isFinite(h) ? `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}` : '';
};

/** A short two-note tone, made in the browser (no sound file). Quietly does nothing if audio is unavailable. */
export function chime() {
  try {
    const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!Context) return;
    const audio = new Context();
    [[880, 0], [1320, 0.16]].forEach(([frequency, at]) => {
      const tone = audio.createOscillator(); const gain = audio.createGain();
      tone.frequency.value = frequency; tone.type = 'sine';
      gain.gain.setValueAtTime(0.0001, audio.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.2, audio.currentTime + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + at + 0.4);
      tone.connect(gain).connect(audio.destination); tone.start(audio.currentTime + at); tone.stop(audio.currentTime + at + 0.45);
    });
    setTimeout(() => audio.close().catch(() => {}), 1200);
  } catch { /* no audio */ }
}

export const SHORTCUTS = [['N', 'New task'], ['H', 'Log help'], ['R', 'Reminder (opens quick add with remind:)'], ['/', 'Search or quick add'],
  ['1 – 9', 'Switch tabs, in the order shown'], ['Alt ← / →', 'Move the selected board card one lane'], ['Esc', 'Close a panel or quick add']];
