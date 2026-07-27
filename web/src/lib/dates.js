// Date helpers shared by the data hooks. Everything is computed in IST, never via
// toISOString() on a local Date — between 00:00 and 05:30 IST that would return yesterday.
const IST = 'Asia/Kolkata';

/** Today as 'YYYY-MM-DD' in IST. */
export function istToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: IST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * "2h ago" stamp for activity feeds, where recency matters more than the exact instant. Past a
 * week that stops being useful, so it falls back to a plain date. Pair it with the full timestamp
 * in a `title` for anyone who needs the precise moment.
 */
export function relativeTime(iso) {
  const then = new Date(iso);
  const secs = (Date.now() - then.getTime()) / 1000;
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 604800) return `${Math.floor(secs / 86400)}d ago`;
  return then.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: IST });
}

/**
 * 'YYYY-MM-DD' for N days before today (IST) — used to bound list queries so they cannot grow
 * without limit as the company accumulates years of history.
 */
export function windowStartIso(days) {
  const d = new Date(`${istToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
