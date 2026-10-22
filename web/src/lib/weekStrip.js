// The days a phone's week strip shows (round 2, after the reference phone kit): Monday to Sunday
// around a chosen day, as ISO dates. Date arithmetic is in UTC so a day never slips across a
// timezone edge.

const shift = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Monday to Sunday of the week that contains `iso`. */
export function weekDays(iso) {
  const weekday = (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  const monday = shift(iso, -weekday);
  return Array.from({ length: 7 }, (_, i) => shift(monday, i));
}

/** The same weekday a week earlier or later. */
export const shiftWeek = (iso, weeks) => shift(iso, weeks * 7);

/** Every day of the month that contains `iso`, for the swipeable day strip. */
export function monthDays(iso) {
  const [y, m] = iso.split('-').map(Number);
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => `${iso.slice(0, 7)}-${String(i + 1).padStart(2, '0')}`);
}

/** The month before or after: today if that is the current month, else its first day. */
export function shiftMonth(iso, months, today) {
  const [y, m] = iso.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1)).toISOString().slice(0, 10);
  return first.slice(0, 7) === String(today ?? '').slice(0, 7) ? today : first;
}

/** The same, under a name that does not clash with a screen's own month stepper. */
export const moveMonth = (iso, months, today) => shiftMonth(iso, months, today);

/** How the punches of a day read as a timeline: in, then breaks and returns, then out. */
export function punchSteps(punches) {
  const list = Array.isArray(punches) ? punches.filter(Boolean) : [];
  return list.map((at, i) => {
    if (i === 0) return { at, label: 'Checked in' };
    if (i === list.length - 1) return { at, label: 'Checked out' };
    return { at, label: i % 2 === 1 ? 'Break' : 'Back to work' };
  });
}
