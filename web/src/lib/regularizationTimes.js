// Corrections use IST wall-clock times regardless of the browser's timezone. Overnight exits
// are explicit, including checkout-only requests where no arrival time exists to compare.
export function regularizationTimes({ workDate, checkIn, checkOut, checkOutNextDay = false }) {
  const date = new Date(`${workDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate ?? '') || !Number.isFinite(date.getTime())
      || date.toISOString().slice(0, 10) !== workDate) {
    throw new Error('Enter a valid work date.');
  }
  if (!checkIn && !checkOut) throw new Error('Enter a check-in or check-out time to request a correction.');
  const atIst = (clock, nextDay = false) => {
    if (!clock) return null;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(clock)) throw new Error('Enter a valid time in HH:mm format.');
    const instant = new Date(`${workDate}T${clock}:00+05:30`);
    if (nextDay) instant.setUTCDate(instant.getUTCDate() + 1);
    return instant.toISOString();
  };
  const times = { checkIn: atIst(checkIn), checkOut: atIst(checkOut, checkOutNextDay === true) };
  if (times.checkIn && times.checkOut && times.checkOut <= times.checkIn) {
    throw new Error('Check-out must be after check-in. For an overnight shift, select “Check-out is next day”.');
  }
  return times;
}

/** Show a correction's actual checkout date in review, rather than concealing an overnight exit. */
export function correctionDateLabel(timestamp, workDate) {
  if (!timestamp) return '';
  const instant = new Date(timestamp);
  if (!Number.isFinite(instant.getTime())) return '';
  const date = new Date(instant.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  return date === workDate ? '' : ` (${date})`;
}
