import { regularizationTimes } from './regularizationTimes.js';
import { firstRecordedPunch, latestRecordedPunch } from './recordedPunches.js';

const instant = value => typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;

// The context includes raw punches from adjacent days. Never search that list by clock minute:
// use the selected day's known endpoint, corroborated by its recorded first/last punch instead.
export function punchCorrectionEndpointEvidence(context) {
  const approved = context?.active_correction?.status === 'Approved' ? context.active_correction : null;
  const attendance = context?.attendance;
  const sameDay = attendance && (!attendance.employee_id || attendance.employee_id === context.employee_id)
    && (!attendance.work_date || attendance.work_date === context.work_date);
  const rawTimes = new Set((context?.raw_punches ?? []).map(punch => instant(punch.punch_time)).filter(Number.isFinite));
  const endpoint = (field, recorded) => {
    // Keep an existing approved endpoint even while its attendance recomputation is pending.
    if (Number.isFinite(instant(approved?.[field]))) return approved[field];
    const value = sameDay ? attendance[field] : null;
    const time = instant(value);
    return Number.isFinite(time) && time === instant(recorded) && rawTimes.has(time) ? value : null;
  };
  return {
    checkIn: endpoint('check_in', firstRecordedPunch(attendance)),
    checkOut: endpoint('check_out', latestRecordedPunch(attendance)),
  };
}

// Time inputs edit minutes, while punches retain seconds. Re-entering 09:22 for a known
// 09:22:09 endpoint must not create an earlier arrival and change how break punches pair.
// Evidence belongs to the draft's original source revision, so retries send identical instants.
export function punchCorrectionTimes({ endpointEvidence, ...input }) {
  const times = regularizationTimes(input);
  for (const key of ['checkIn', 'checkOut']) {
    const reviewed = endpointEvidence?.[key];
    const exact = instant(reviewed);
    if (times[key] && Number.isFinite(exact)
      && Math.floor(Date.parse(times[key]) / 60_000) === Math.floor(exact / 60_000)) {
      times[key] = reviewed;
    }
  }
  return times;
}
