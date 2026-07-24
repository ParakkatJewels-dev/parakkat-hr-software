// Every timezone decision in the system lives here.
//
// The contract, per the project constraint:
//   - the database stores UTC (timestamptz)
//   - all business logic — work dates, shift boundaries, reports — runs in APP_TIMEZONE (IST)
//   - BioTime hands back NAIVE local strings ("2026-07-23 09:15:32") with no offset, in
//     BIOTIME_TIMEZONE, and they are converted the moment they enter the system
//
// A "work date" is a plain calendar date in IST. Never derive it with
// `new Date().toISOString().split('T')[0]` — that is UTC and is wrong by 5h30m every evening
// after 18:30 IST, which silently files evening punches under the previous day.
import { DateTime, Duration, Interval } from 'luxon';
import { env } from '../config/env';

export const APP_TZ = env.APP_TIMEZONE;
export const BIOTIME_TZ = env.BIOTIME_TIMEZONE;

/** BioTime's naive local datetime string -> a UTC Date for storage. */
export function parseBiotimeDateTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  // Common shapes: "2026-07-23 09:15:32", "2026-07-23T09:15:32", with optional fractional seconds.
  const normalized = raw.replace(' ', 'T');

  // If BioTime was configured to emit an offset, honour it rather than re-interpreting.
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized);
  const dt = hasOffset
    ? DateTime.fromISO(normalized, { setZone: true })
    : DateTime.fromISO(normalized, { zone: BIOTIME_TZ });

  if (!dt.isValid) return null;
  return dt.toUTC().toJSDate();
}

/** A UTC instant -> the naive local string BioTime expects in query params. */
export function toBiotimeParam(date: Date): string {
  return DateTime.fromJSDate(date, { zone: 'utc' })
    .setZone(BIOTIME_TZ)
    .toFormat('yyyy-MM-dd HH:mm:ss');
}

/** The calendar date (IST) an instant falls on. */
export function toWorkDate(date: Date): string {
  return DateTime.fromJSDate(date, { zone: 'utc' }).setZone(APP_TZ).toFormat('yyyy-MM-dd');
}

/** Today's work date in IST. */
export function todayWorkDate(): string {
  return DateTime.now().setZone(APP_TZ).toFormat('yyyy-MM-dd');
}

/** 'yyyy-MM-dd' -> the UTC instant of local midnight starting that date. */
export function workDateStart(workDate: string): Date {
  return DateTime.fromISO(workDate, { zone: APP_TZ }).startOf('day').toUTC().toJSDate();
}

/** 'yyyy-MM-dd' -> the UTC instant that ends that local day (exclusive). */
export function workDateEnd(workDate: string): Date {
  return DateTime.fromISO(workDate, { zone: APP_TZ }).endOf('day').toUTC().toJSDate();
}

/**
 * Combine a work date with a shift clock time ("09:30" / "09:30:00") into a UTC instant.
 * `dayOffset` shifts to the next day, which is how a night shift's end time is expressed.
 */
export function workDateAtTime(workDate: string, clock: string, dayOffset = 0): Date {
  const [h = '0', m = '0', s = '0'] = clock.split(':');
  return DateTime.fromISO(workDate, { zone: APP_TZ })
    .startOf('day')
    .plus({ days: dayOffset })
    .set({ hour: Number(h), minute: Number(m), second: Number(s), millisecond: 0 })
    .toUTC()
    .toJSDate();
}

/** Inclusive list of work dates between two 'yyyy-MM-dd' bounds. Guards against reversed input. */
export function eachWorkDate(from: string, to: string): string[] {
  let start = DateTime.fromISO(from, { zone: APP_TZ }).startOf('day');
  let end = DateTime.fromISO(to, { zone: APP_TZ }).startOf('day');
  if (!start.isValid || !end.isValid) return [];
  if (end < start) [start, end] = [end, start];

  const out: string[] = [];
  for (let d = start; d <= end; d = d.plus({ days: 1 })) {
    out.push(d.toFormat('yyyy-MM-dd'));
  }
  return out;
}

/** Day of week in IST, 0 = Sunday … 6 = Saturday — matching shifts.weekly_offs. */
export function weekdayOf(workDate: string): number {
  // luxon: 1 = Monday … 7 = Sunday
  return DateTime.fromISO(workDate, { zone: APP_TZ }).weekday % 7;
}

/** First and last date of the month containing `workDate`. */
export function monthBounds(year: number, month: number): { from: string; to: string } {
  const start = DateTime.fromObject({ year, month, day: 1 }, { zone: APP_TZ });
  return {
    from: start.toFormat('yyyy-MM-dd'),
    to: start.endOf('month').toFormat('yyyy-MM-dd'),
  };
}

/** Format a stored UTC instant as IST wall-clock, for reports and exports. */
export function formatLocalTime(date: Date | null | undefined, fmt = 'HH:mm'): string {
  if (!date) return '';
  return DateTime.fromJSDate(date, { zone: 'utc' }).setZone(APP_TZ).toFormat(fmt);
}

export function formatLocalDateTime(date: Date | null | undefined): string {
  return formatLocalTime(date, 'yyyy-MM-dd HH:mm:ss');
}

export function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 60_000);
}

export function minutesToHours(minutes: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round((minutes / 60) * f) / f;
}

/** "7h 45m" — used in the UI and exception reports. */
export function humanizeMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0m';
  return Duration.fromObject({ minutes: Math.round(minutes) })
    .shiftTo('hours', 'minutes')
    .toHuman({ unitDisplay: 'short', maximumFractionDigits: 0 })
    .replace(/,/g, '');
}

export { DateTime, Interval };
