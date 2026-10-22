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

/** How the punches of a day read as a timeline: in, then breaks and returns, then out. */
export function punchSteps(punches) {
  const list = Array.isArray(punches) ? punches.filter(Boolean) : [];
  return list.map((at, i) => {
    if (i === 0) return { at, label: 'Checked in' };
    if (i === list.length - 1) return { at, label: 'Checked out' };
    return { at, label: i % 2 === 1 ? 'Break' : 'Back to work' };
  });
}
