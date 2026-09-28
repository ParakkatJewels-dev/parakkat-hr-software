import { addDays } from './dateRange.js';

/** Default edits to the next interval occurrence so adding a job does not change its cadence. */
export function routineEditStartDate(schedule, today) {
  const start = schedule?.start_date;
  const firstDate = start > today ? start : today;
  const interval = Number(schedule?.interval_days);
  if (schedule?.frequency !== 'interval' || !start || !Number.isInteger(interval) || interval < 1 || interval > 366) return firstDate;
  const elapsed = (Date.parse(`${firstDate}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86_400_000;
  if (!Number.isInteger(elapsed)) return firstDate;
  return addDays(firstDate, (interval - elapsed % interval) % interval);
}
