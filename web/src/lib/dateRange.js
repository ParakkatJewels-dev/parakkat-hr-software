// Calendar-date arithmetic for the attendance period filter.
//
// Deliberately dependency-free — no React, no Supabase, no clock of its own. Everything takes and
// returns 'YYYY-MM-DD' and today is passed in, which is what makes it testable (see
// dateRange.test.js) and what keeps the one genuinely dangerous rule in a single place:
//
//   NEVER derive a date from toISOString(). It is UTC, this company is UTC+5:30, and between
//   midnight and 05:30 IST it hands back yesterday. Three attendance screens computed "today" that
//   way before this file existed.
//
// Parsing at noon UTC is what makes the arithmetic safe: adding or subtracting whole days can
// never land on the wrong side of a date boundary, because noon has twelve hours of slack in both
// directions. toISOString() is then safe to format with, because we control the instant.

const parse = (isoDate) => new Date(`${isoDate}T12:00:00Z`);
const fmt = (d) => d.toISOString().slice(0, 10);

export const addDays = (isoDate, n) => {
  const d = parse(isoDate);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
};

/**
 * Whole calendar months, clamped to the end of the month landed on.
 *
 * Without the clamp, three months before 31 May is 31 February, which JavaScript rolls forward
 * into March — a "last 3 months" range that silently starts in the wrong month. Clamping gives
 * 28 or 29 February, which is what anyone means by it.
 */
export const addMonths = (isoDate, n) => {
  const d = parse(isoDate);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const lastOfMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastOfMonth));
  return fmt(d);
};

export const startOfMonth = (isoDate) => `${isoDate.slice(0, 8)}01`;

/**
 * The last day of the month `isoDate` falls in.
 *
 * Day 0 of the NEXT month is the last day of this one, which is how this avoids a 28/29/30/31
 * table and gets February right in a leap year for free.
 */
export const endOfMonth = (isoDate) => {
  const d = parse(isoDate);
  return fmt(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
};

export const RANGE_PRESETS = [
  { key: 'today', label: 'Today', of: (t) => ({ from: t, to: t }) },
  // The last seven days including today, not the previous Monday-to-Sunday. "Last week" asked on a
  // Wednesday nearly always means "the week just gone", and a calendar week would answer for a
  // period that ended two days ago.
  { key: 'week', label: 'Last week', of: (t) => ({ from: addDays(t, -6), to: t }) },
  { key: 'month', label: 'This month', of: (t) => ({ from: startOfMonth(t), to: t }) },
  // A WHOLE calendar month, 1st to last — unlike its neighbours, which both run up to today.
  //
  // That is the point of it: payroll, a month-end register and "how did we do in July" are all
  // questions about a closed month, and "This month" on the 3rd answers with three days. Anchored
  // to the 1st before stepping back so the arithmetic cannot land on a day the previous month does
  // not have — from the 31st, addMonths already clamps, but starting from the 1st means there is
  // nothing to clamp and the intent stays readable.
  {
    key: 'lastMonth',
    label: 'Last month',
    of: (t) => {
      const inPreviousMonth = addMonths(startOfMonth(t), -1);
      return { from: startOfMonth(inPreviousMonth), to: endOfMonth(inPreviousMonth) };
    },
  },
  { key: 'quarter', label: 'Last 3 months', of: (t) => ({ from: addMonths(t, -3), to: t }) },
  { key: 'custom', label: 'Custom', of: null },
];

/**
 * The from/to a preset means on a given day.
 *
 * 'custom' and unknown keys return null — the caller keeps whatever dates it already had, which is
 * what makes switching to Custom a no-op rather than a reset.
 */
export function rangeFor(key, today) {
  const preset = RANGE_PRESETS.find((p) => p.key === key);
  return preset?.of ? preset.of(today) : null;
}
