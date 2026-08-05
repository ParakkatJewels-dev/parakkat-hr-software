// How long a spell of custody ran, in words.
//
// Lives here rather than in the component so it can be tested: the interesting cases are the ones
// nobody looks at on screen — a spell that is still open, one that starts today, and the boundary
// where months should stop counting and become years.
//
// No imports on purpose; the test runner cannot load anything that reaches Supabase.

/**
 * '11 days', '4 months', '1y 2m'. Null when the dates make no sense.
 *
 * `to` omitted means the asset is still out, so the span runs to now.
 */
export function spanLabel(fromIso, toIso, now = new Date()) {
  if (!fromIso) return null;
  const from = new Date(fromIso);
  const to = toIso ? new Date(toIso) : now;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;

  const days = Math.floor((to - from) / 86400000);
  if (days < 0) return null;

  // 'today' only means anything for a spell that is still running. A closed spell from 2020 that
  // happened to last nine hours is not "today", and the timeline printed exactly that.
  if (days < 1) return toIso ? 'same day' : 'today';
  if (days < 31) return `${days} day${days === 1 ? '' : 's'}`;

  // Calendar months, counted the way tenure is counted on the employee profile. Dividing days by
  // an average month looks equivalent and is not: 365 days comes out as 11.99, floors to 11, and a
  // laptop held for exactly a year reads as "11 months".
  let months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12
    + (to.getUTCMonth() - from.getUTCMonth());

  // The day-of-month comparison has to allow for months of different lengths. 31 Jan to 30 Apr is
  // three whole months, but 30 < 31 so a naive decrement calls it two. A return that lands on the
  // last day of its own month has completed that month whatever the handover day was.
  const lastDayOfToMonth = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() + 1, 0)).getUTCDate();
  if (to.getUTCDate() < from.getUTCDate() && to.getUTCDate() !== lastDayOfToMonth) months -= 1;

  if (months < 12) return `${months} month${months === 1 ? '' : 's'}`;

  const years = Math.floor(months / 12);
  const rest = months % 12;
  return rest ? `${years}y ${rest}m` : `${years} year${years === 1 ? '' : 's'}`;
}
