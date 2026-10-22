// My attendance for one day, on a phone (round 2, after the reference phone kit): the month and
// week to pick a day, a ring with the first punch and the day's status, hours worked and breaks,
// then the punches as a timeline. The face machines record the punches, so there are no check-in
// or break buttons — a day that looks wrong goes to Fix attendance instead.
import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, Clock, Coffee, Fingerprint } from 'lucide-react';
import { useEmployeeAttendance } from '../../data/employeeAttendance';
import { todayIso, fmtTime, fmtMinutes } from '../../data/attendance';
import { attendanceTimeline } from '../../lib/attendanceTimeline';
import { firstRecordedPunch } from '../../lib/recordedPunches';
import { toneForStatus } from '../../lib/statusTone';
import { weekDays, shiftWeek, punchSteps } from '../../lib/weekStrip';
import { segments } from '../ui/PunchTimeline';
import StatusPill from '../ui/StatusPill';
import { Skeleton } from '../ui/Skeleton';
import './myDayPhone.css';

const label = (iso, options) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', ...options });

/** A day's status word: the row's, or what an empty past/future day means. */
function dayStatus(row, iso, today) {
  if (row) return row.is_late && row.status === 'Present' ? 'Late' : row.status || 'Pending';
  return iso > today ? null : 'No record';
}

export default function MyDayPhone({ employeeId, onFix }) {
  const today = todayIso();
  const [day, setDay] = useState(today);
  const week = weekDays(day);
  const { data: rows = [], isLoading } = useEmployeeAttendance(employeeId, week[0], week[6]);
  const byDate = new Map(rows.map((r) => [r.work_date, r]));
  const row = byDate.get(day);
  const status = dayStatus(row, day, today);
  const tone = status ? toneForStatus(status) : 'neutral';
  const first = firstRecordedPunch(row);
  const timeline = row ? attendanceTimeline(row) : [];
  const steps = punchSteps(timeline);
  const breaks = segments(timeline).filter((s) => s.away).length;
  const stillIn = day === today && timeline.length % 2 === 1;

  return (
    <section className="my-day-phone" aria-label="My day">
      <div className="my-day-month">
        <button type="button" onClick={() => setDay(shiftWeek(day, -1))} aria-label="Previous week"><ChevronLeft size={18} /></button>
        <strong>{label(day, { month: 'long', year: 'numeric' })}</strong>
        <button type="button" onClick={() => setDay(shiftWeek(day, 1))} aria-label="Next week"><ChevronRight size={18} /></button>
      </div>

      <div className="my-day-week" role="group" aria-label="Days of the week">
        {week.map((iso) => {
          const s = dayStatus(byDate.get(iso), iso, today);
          return (
            <button key={iso} type="button" onClick={() => setDay(iso)} aria-pressed={iso === day}
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
            <circle cx="60" cy="60" r="52" className="my-day-ring-fill" pathLength="100" strokeDasharray={first ? '100 0' : '0 100'} />
          </svg>
          <div className="my-day-ring-copy">
            {isLoading ? <Skeleton className="h-8 w-24" /> : <>
              <span>{first ? 'Checked in' : day > today ? 'Coming up' : 'No punch'}</span>
              <strong>{first ? fmtTime(first) : '--:--'}</strong>
              <small>{day === today ? 'Today' : label(day, { weekday: 'short', day: 'numeric', month: 'short' })}</small>
              {status && <StatusPill status={status} />}
            </>}
          </div>
        </div>
        <div className="my-day-facts">
          <div><Clock size={16} aria-hidden="true" /><span>Worked</span><strong>{row?.worked_minutes ? fmtMinutes(row.worked_minutes) : stillIn ? 'In progress' : '—'}</strong></div>
          <div><Coffee size={16} aria-hidden="true" /><span>Breaks</span><strong>{timeline.length >= 4 ? `${breaks} · ${row.break_minutes ?? 0}m` : '—'}</strong></div>
        </div>
      </div>

      <div className="my-day-timeline">
        <h3>{day === today ? 'Today’s timeline' : 'Timeline'}</h3>
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
        {(row?.is_missing_punch || row?.breaks_incomplete) && (
          <button type="button" className="my-day-fix" onClick={onFix}><Fingerprint size={16} aria-hidden="true" /> Fix attendance for this day</button>
        )}
      </div>
    </section>
  );
}
