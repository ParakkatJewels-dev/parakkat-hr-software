// My attendance for one day, on a phone (round 2, after the reference phone kit): the month and
// a swipeable strip of its days, a ring with the day's total work time and status, the check-in
// and the last check-out under it (round 3), then the punches as a timeline. The chosen day is shared with the month calendar
// and month list below it, so a day picked anywhere shows here. The face machines record the
// punches, so there are no check-in or break buttons — a day that looks wrong goes to Fix
// attendance instead.
import React, { useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, Fingerprint, LogIn, LogOut, TrendingUp } from 'lucide-react';
import { useMonthlyAttendance, todayIso, fmtTime, fmtMinutes } from '../../data/attendance';
import { attendanceTimeline } from '../../lib/attendanceTimeline';
import { firstRecordedPunch, latestRecordedPunch } from '../../lib/recordedPunches';
import { toneForStatus } from '../../lib/statusTone';
import { monthDays, shiftMonth, punchSteps } from '../../lib/weekStrip';
import StatusPill from '../ui/StatusPill';
import { Skeleton } from '../ui/Skeleton';
import './myDayPhone.css';

const label = (iso, options) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', ...options });

/** A day's status word: the row's, or what an empty past/future day means. */
export function dayStatus(row, iso, today) {
  if (row) return row.is_late && row.status === 'Present' ? 'Late' : row.status || 'Pending';
  return iso > today ? null : 'No record';
}

export default function MyDayPhone({ employeeId, day, onDay, onFix, onOverview }) {
  const today = todayIso();
  const [year, month] = [Number(day.slice(0, 4)), Number(day.slice(5, 7))];
  const { data: rows = [], isLoading } = useMonthlyAttendance(employeeId, year, month);
  const byDate = new Map(rows.map((r) => [r.work_date, r]));
  const days = monthDays(day);
  const row = byDate.get(day);
  const status = dayStatus(row, day, today);
  const tone = status ? toneForStatus(status) : 'neutral';
  const first = firstRecordedPunch(row);
  const timeline = row ? attendanceTimeline(row) : [];
  const steps = punchSteps(timeline);
  const stillIn = day === today && timeline.length % 2 === 1;
  // The last punch is a check-out once the day has an even number of them (in, out, in, out…).
  const lastOut = timeline.length >= 2 && timeline.length % 2 === 0 ? latestRecordedPunch(row) : null;
  const worked = row?.worked_minutes ? fmtMinutes(row.worked_minutes) : null;

  // Keep the chosen day in the middle of the strip, however it was chosen.
  const strip = useRef(null);
  useEffect(() => {
    const el = strip.current?.querySelector('[aria-pressed="true"]');
    el?.scrollIntoView?.({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [day]);

  return (
    <section className="my-day-phone" aria-label="My day">
      <div className="my-day-month">
        <button type="button" onClick={() => onDay(shiftMonth(day, -1, today))} aria-label="Previous month"><ChevronLeft size={18} /></button>
        <strong>{label(day, { month: 'long', year: 'numeric' })}</strong>
        <button type="button" onClick={() => onDay(shiftMonth(day, 1, today))} aria-label="Next month"><ChevronRight size={18} /></button>
      </div>

      <div className="my-day-week" role="group" aria-label="Days of the month" ref={strip}>
        {days.map((iso) => {
          const s = dayStatus(byDate.get(iso), iso, today);
          return (
            <button key={iso} type="button" onClick={() => onDay(iso)} aria-pressed={iso === day}
              aria-label={`${label(iso, { weekday: 'long', day: 'numeric', month: 'long' })}${s ? `, ${s}` : ''}`}
              className={`my-day-weekday ${iso === day ? 'is-selected' : ''} ${iso === today ? 'is-today' : ''}`}>
              <span>{label(iso, { weekday: 'short' })}</span>
              <strong>{Number(iso.slice(8))}</strong>
              <i data-tone={s && s !== 'No record' ? toneForStatus(s) : 'none'} aria-hidden="true" />
            </button>
          );
        })}
      </div>

      <div className="my-day-ring-card">
        <div className="my-day-ring" data-tone={tone}>
          <svg viewBox="0 0 120 120" aria-hidden="true">
            <circle cx="60" cy="60" r="52" className="my-day-ring-track" />
            {first && <circle cx="60" cy="60" r="52" className="my-day-ring-fill" />}
          </svg>
          <div className="my-day-ring-copy">
            {isLoading ? <Skeleton className="h-8 w-24" /> : <>
              <span>{first ? (stillIn ? 'Worked so far' : 'Total work time') : day > today ? 'Coming up' : 'No punch'}</span>
              <strong className={first && !worked ? 'is-pending' : ''}>{worked ?? (first ? (stillIn ? 'In progress' : '—') : '--:--')}</strong>
              <small>{day === today ? 'Today' : label(day, { weekday: 'short', day: 'numeric', month: 'short' })}</small>
              {status && <StatusPill status={status} />}
            </>}
          </div>
        </div>
        <div className="my-day-facts">
          <div><LogIn size={16} aria-hidden="true" /><span>Check in</span><strong>{first ? fmtTime(first) : '—'}</strong></div>
          <div><LogOut size={16} aria-hidden="true" /><span>Last check-out</span><strong>{lastOut ? fmtTime(lastOut) : stillIn ? 'Still in' : '—'}</strong></div>
        </div>
      </div>

      <div className="my-day-timeline">
        <h3>{day === today ? 'Today’s timeline' : `Timeline · ${label(day, { day: 'numeric', month: 'short' })}`}</h3>
        {steps.length === 0 ? (
          <p className="my-day-empty">{day > today ? 'Nothing yet — this day is still ahead.' : 'No punches recorded for this day.'}</p>
        ) : (
          <ol>
            {steps.map((step, i) => (
              <li key={`${step.at}-${i}`} data-kind={i === 0 ? 'in' : step.label === 'Checked out' ? 'out' : 'mid'}>
                <time>{fmtTime(step.at)}</time><span>{step.label}</span>
              </li>
            ))}
            {stillIn && <li data-kind="pending"><time>--:--</time><span>Check out</span></li>}
          </ol>
        )}
        <div className="my-day-links">
          <button type="button" data-tone={row?.is_missing_punch || row?.breaks_incomplete ? 'warn' : undefined} onClick={onFix}>
            <Fingerprint size={16} aria-hidden="true" /> Fix attendance
          </button>
          {onOverview && <button type="button" onClick={onOverview}><TrendingUp size={16} aria-hidden="true" /> Overview</button>}
        </div>
      </div>
    </section>
  );
}
