// Formatting a time of day, in whichever of the two shapes the reader prefers.
//
// The app was doing this six different ways, and disagreeing with itself inside a single component:
// the punch timeline printed "9:37 am" in its header and "09:37" on the bar directly below it, and
// EmployeeAttendanceDetail defined a local 12-hour fmtTime that shadowed the shared 24-hour one, so
// the same check-in read differently on two screens.
//
// Everything now comes through here. Always Asia/Kolkata — the punches are IST and a browser in
// another timezone must not shift them, which is the sort of thing that only shows up when somebody
// checks the roster from abroad.
//
// Pure and dependency-free, `hour12` passed in, so both shapes can be tested without a browser.
const TZ = 'Asia/Kolkata';

/**
 * "09:37" or "9:37 am" from an ISO timestamp.
 *
 * Padded in 24-hour and unpadded in 12-hour, which is how each is normally written: 09:37 lines up
 * in a column of times, and "09:37 am" reads like a typo.
 */
export function formatClock(iso, hour12 = false) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';

  return d.toLocaleTimeString('en-GB', {
    timeZone: TZ,
    hour: hour12 ? 'numeric' : '2-digit',
    minute: '2-digit',
    hour12,
  }).replace(/\s?([ap])\.?m\.?/i, (_, p) => ` ${p.toLowerCase()}m`);
}

/**
 * The same, from minutes past midnight rather than a timestamp.
 *
 * Used for figures that are already an average — "average arrival 9:41 am" — where there is no
 * single instant to format.
 */
export function formatMinutesOfDay(minutes, hour12 = false) {
  if (minutes == null || Number.isNaN(Number(minutes))) return '—';

  const total = ((Math.round(Number(minutes)) % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60);
  const m = total % 60;
  const mm = String(m).padStart(2, '0');

  if (!hour12) return `${String(h).padStart(2, '0')}:${mm}`;

  const suffix = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${mm} ${suffix}`;
}

/** The two choices, for a settings control. */
export const CLOCK_FORMATS = [
  { value: false, key: '24', label: '24-hour', example: '17:30' },
  { value: true, key: '12', label: '12-hour', example: '5:30 pm' },
];
