// The numbers behind the per-person attendance screen, derived from its rows.
//
// Split out of data/employeeAttendance.js, which imports Supabase and TanStack Query and therefore
// cannot be loaded by a test runner. This half is pure — rows in, figures out — and it is where the
// mistakes have been: percentages against the wrong denominator, a punctuality rate that went
// negative, and hours totals that quietly dropped every Sunday. See employeeAttendance.test.js.

const mins = (v) => Number(v) || 0;

/**
 * A day nobody was scheduled to work. The engine writes day_type as 'weekly_off' / 'holiday' /
 * 'working'; an earlier version of this file compared against 'Weekly Off' and 'Holiday', which
 * matched nothing, so every Sunday was silently counted as a working day and every percentage
 * below was computed against the wrong denominator. Normalising means neither spelling can bite
 * again if the engine's vocabulary ever changes.
 */
const isOffDay = (r) => {
  const t = String(r.day_type ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  return t === 'weekly_off' || t === 'holiday';
};

/**
 * Weekday of a work_date, 0 = Sunday.
 *
 * PostgREST hands `work_date` back as the string '2026-07-21', and appending 'T00:00:00' to that
 * is what keeps the date in local time instead of being read as UTC and slipping to the previous
 * day west of Greenwich. Anything else reaching this function — a Date, a full timestamp — used to
 * produce an Invalid Date and a NaN index, which reads an undefined slot out of the byDow array
 * and throws. Cheap to accept both.
 */
const weekdayOf = (workDate) => {
  const d = workDate instanceof Date ? workDate : new Date(`${String(workDate).slice(0, 10)}T00:00:00`);
  const dow = d.getDay();
  return Number.isNaN(dow) ? null : dow;
};

/**
 * Everything the detail screen shows, computed in one pass.
 *
 * Percentages use WORKING days as the denominator, not calendar days — a 30-day month with four
 * Sundays is 26 working days, and 22/30 reads as poor attendance when 22/26 is the truth.
 */
export function summarise(rows) {
  const working = rows.filter((r) => !isOffDay(r));

  const present = working.filter((r) => r.status === 'Present').length;
  const halfDays = working.filter((r) => r.status === 'Half Day').length;
  const absent = working.filter((r) => r.status === 'Absent').length;
  const leave = working.filter((r) => r.status === 'On Leave').length;
  const lateDays = working.filter((r) => r.is_late).length;
  const earlyDays = working.filter((r) => r.is_early_exit).length;
  const missing = working.filter((r) => r.is_missing_punch).length;
  const lop = working.filter((r) => r.is_lop).length;

  // Days the person actually turned up, whatever the day was ultimately scored as. This is the
  // right denominator for punctuality: lateness is only possible on a day you attended, and it is
  // recorded on Half Day and Missing Punch days too. Dividing by `present` alone produced
  // punctuality of -500% for anyone late on days that did not end up scored Present.
  const attended = working.filter((r) => r.check_in).length;

  // Credit actually earned: 1 for a full day, 0.5 for a half day, 0 for an absence. The engine
  // already decided this per day and payroll pays on it, so attendance should be measured with the
  // same number rather than counting only whole Present days and quietly scoring a half day zero.
  const credit = working.reduce(
    (a, r) => a + (r.day_fraction != null ? Number(r.day_fraction) : r.status === 'Present' ? 1 : 0),
    0
  );

  // HOURS ARE TOTALLED OVER EVERY DAY, INCLUDING DAYS OFF.
  //
  // These used to count working days only, with the note that a Sunday must not inflate the weekday
  // averages. True of the averages below — and wrong for a total, which is not an average. Sunday
  // work simply vanished from both figures on screen:
  //
  //   Kasinath, July: 8132 minutes on working days + 269 on Sunday the 26th.
  //   Total hours read 135.5 h instead of 140.0, and Overtime read 1.5 h instead of 5.9 —
  //   because 269 of his 356 overtime minutes were earned on that Sunday.
  //
  // He is paid for those hours; a screen that hides them cannot be reconciled against a payslip or
  // against Easy Time Pro's own export, which is exactly the complaint that found this. Sunday is a
  // weekly off here and every minute worked on one is overtime, so this is not a rare edge.
  const workedMinutes = rows.reduce((a, r) => a + mins(r.worked_minutes), 0);
  const otMinutes = rows.reduce((a, r) => a + mins(r.ot_minutes), 0);
  // Kept as its own figure so the split stays visible — how much of the overtime was earned on a
  // day off is a fair question, and answering it must not mean leaving it out of the total.
  const offDayOtMinutes = rows.filter(isOffDay).reduce((a, r) => a + mins(r.ot_minutes), 0);

  // Lateness stays on working days: there is no scheduled start on a day off to be late for.
  const lateMinutes = working.reduce((a, r) => a + mins(r.late_minutes), 0);

  // Average arrival, in minutes past midnight, across working days actually attended.
  const arrivals = working
    .filter((r) => r.check_in)
    .map((r) => {
      const d = new Date(r.check_in);
      return d.getHours() * 60 + d.getMinutes();
    });
  const avgArrival = arrivals.length
    ? Math.round(arrivals.reduce((a, b) => a + b, 0) / arrivals.length)
    : null;

  // On a flexible shift there is no start time to be late for, so the engine records no lateness
  // at all and a punctuality percentage would read 100% for everyone, every month — a number that
  // looks like a fact and carries none. What is meaningful there is whether the daily hours were
  // completed, so that is counted alongside and the screen picks whichever the shift supports.
  const flexible = rows.some((r) => r.shift?.is_flexible);
  const targetOf = (r) => Number(r.shift?.full_day_minutes) || 0;
  const isShort = (r) => {
    const target = targetOf(r);
    return target > 0 && mins(r.worked_minutes) < target;
  };

  const attendedDays = working.filter((r) => r.check_in);
  const shortDays = attendedDays.filter(isShort).length;

  // Pattern by weekday — Monday-morning lateness is a real and visible pattern, and so is which
  // day of the week people cut short. Counted over days attended, so a weekday spent absent does
  // not read as a weekday spent on time.
  const byDow = Array.from({ length: 7 }, () => ({ total: 0, late: 0, short: 0 }));
  for (const r of working) {
    if (!r.check_in) continue;
    const dow = weekdayOf(r.work_date);
    if (dow === null) continue;
    byDow[dow].total += 1;
    if (r.is_late) byDow[dow].late += 1;
    if (isShort(r)) byDow[dow].short += 1;
  }

  // Overtime is not additional to worked time, it is the part of it beyond a full day:
  //   worked = time on site - break,  and  worked - overtime = a full day, exactly.
  // Showing the two as separate totals reads as though they add up, which would count the
  // overtime twice. So the split is stated instead.
  const normalMinutes = Math.max(0, workedMinutes - otMinutes);

  return {
    days: rows.length,
    workingDays: working.length,
    offDays: rows.length - working.length,
    present, halfDays, absent, leave, lop,
    attended,
    lateDays, earlyDays, missing,
    // Half days count as half, matching what payroll pays.
    attendanceRate: working.length ? Math.round((credit / working.length) * 100) : null,
    // Never negative: lateDays is a subset of attended by construction.
    punctualityRate: attended ? Math.round(((attended - lateDays) / attended) * 100) : null,
    // The flexible-shift counterpart: did they complete the daily hours?
    flexible,
    shortDays,
    hoursMetRate: attended ? Math.round(((attended - shortDays) / attended) * 100) : null,
    // The headline figure: everything worked, overtime included.
    workedHours: Math.round((workedMinutes / 60) * 10) / 10,
    // Its two parts, which sum back to workedHours rather than adding to it.
    normalHours: Math.round((normalMinutes / 60) * 10) / 10,
    otHours: Math.round((otMinutes / 60) * 10) / 10,
    offDayOtHours: Math.round((offDayOtMinutes / 60) * 10) / 10,
    lateMinutes,
    avgLatePerLateDay: lateDays ? Math.round(lateMinutes / lateDays) : 0,
    avgArrival,
    byDow,
  };
}

/** "9:42 am" from minutes past midnight. */
export function clockLabel(minsPastMidnight) {
  if (minsPastMidnight == null) return '—';
  const h = Math.floor(minsPastMidnight / 60);
  const m = minsPastMidnight % 60;
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}
