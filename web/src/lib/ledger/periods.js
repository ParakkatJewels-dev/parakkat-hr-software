// Work Ledger report periods. Pure functions: shared by the screens, the tests and (later) the
// assistant gateway. Dates are 'YYYY-MM-DD' strings in Asia/Kolkata; the week runs Monday–Sunday.
import { istToday } from '../dates.js';

export const PERIODS = ['day', 'week', 'month', 'all', 'range'];
export const PERIOD_TITLES = { day: 'Daily', week: 'Weekly', month: 'Monthly', all: 'Overall', range: 'Period' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Parse 'YYYY-MM-DD' without time-zone drift. */
export function parseDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCMonth() === Number(match[2]) - 1 ? date : null;
}
const iso = (date) => date.toISOString().slice(0, 10);
export const addDays = (value, days) => { const d = parseDay(value); d.setUTCDate(d.getUTCDate() + days); return iso(d); };

/** "7 October 2026" */
export function longDate(value) {
  const d = parseDay(value);
  return d ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : '';
}
/** "7 Oct" */
export function shortDate(value) {
  const d = parseDay(value);
  return d ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)}` : '';
}
/** "10-07" for note prefixes in multi-day reports. */
export const monthDay = (value) => (value ?? '').slice(5, 10);

/** Monday of the week containing the day. */
export function weekStart(value) {
  const d = parseDay(value);
  const back = (d.getUTCDay() + 6) % 7;
  return addDays(value, -back);
}

/** The `_date` argument ledger_report expects for a period. */
export function periodArgument(period, { day, month, from, to } = {}) {
  if (period === 'day' || period === 'week') return day ?? istToday();
  if (period === 'month') return month ?? istToday().slice(0, 7);
  if (period === 'range') return `${from}|${to}`;
  return null;
}

/** The second line of a report: "7 October 2026", "6 Oct – 12 Oct 2026", "October 2026", "Everything up to …". */
export function periodLabel(report) {
  const { period, from, to, today } = report;
  if (period === 'day') return longDate(from);
  if (period === 'all') return `Everything up to ${longDate(to ?? today)}`;
  if (period === 'month') {
    const d = parseDay(from);
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }
  const start = parseDay(from), end = parseDay(to);
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  return `${shortDate(from)}${sameYear ? '' : ` ${start.getUTCFullYear()}`} – ${shortDate(to)} ${end.getUTCFullYear()}`;
}
