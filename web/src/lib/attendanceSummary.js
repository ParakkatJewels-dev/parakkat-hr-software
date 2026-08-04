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
  // Time actually inside — totalled ONLY over the days it can be measured on.
  //
  // A day with one punch has no measurable inside time: we know when they touched the terminal and
  // nothing else. The engine still credits it a full day from the schedule, so summing `inside`
  // with `?? 0` while `worked` keeps its 510 minutes compares two different sets of days. That is
  // not a rounding difference — Akhil Aji's twelve July days are all single-punch, which printed
  // "Total hours 90.8, Inside 0.0" and a claimed 90.8 hours of break allowance against a real 0.0.
  // Narayanan's read 119.2 hours of allowance against a real 0.7.
  //
  // So the two figures are totalled over the same rows, and the days that cannot be measured are
  // counted and named instead of being silently folded in as zeroes.
  const measurable = rows.filter((r) => insideMinutes(r) !== null);
  const insideTotal = measurable.reduce((a, r) => a + insideMinutes(r), 0);
  const workedWhereMeasured = measurable.reduce((a, r) => a + mins(r.worked_minutes), 0);
  // Days that were paid but where nobody can say how long the person was actually in the building.
  const unmeasuredDays = rows.filter(
    (r) => insideMinutes(r) === null && mins(r.worked_minutes) > 0
  ).length;
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

  /**
   * Short by the ENGINE's definition — the stored flag, not a fresh comparison here.
   *
   * This used to recompute it as `worked < full_day`, with no tolerance. The engine allows 30
   * minutes, deliberately: the median day here is 8:31 against a 8:30 target, so a hard threshold
   * sits directly on top of the distribution and flags half the company for finishing a minute
   * early. The two definitions disagreed on 1,041 of July's days — 1,738 by this file's rule
   * against 697 by the engine's — and the screen showed the inflated one while the CSV beside it
   * showed the engine's. Akshay Das, present 27 of 27 days, read "Hours completed 19%" in amber on
   * screen and "Short days: 5" in his export.
   *
   * Falling back to the raw comparison only for rows saved before the flag existed.
   */
  const targetOf = (r) => Number(r.shift?.full_day_minutes) || 0;
  const isShort = (r) => {
    if (r.is_short_day != null) return Boolean(r.is_short_day);
    const target = targetOf(r);
    const tolerance = Number(r.shift?.short_day_tolerance_minutes) || 0;
    return target > 0 && target - mins(r.worked_minutes) > tolerance;
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
    // What the clock actually saw them inside for, over the days it could be seen at all.
    insideHours: Math.round((insideTotal / 60) * 10) / 10,
    // The break given back, measured over those SAME days — never workedHours - insideHours, which
    // silently includes days that carry hours on one side and nothing on the other.
    insideAllowanceHours: Math.round(((workedWhereMeasured - insideTotal) / 60) * 10) / 10,
    // How many paid days the inside figure cannot speak for. Non-zero means the tile is reporting
    // on less than the whole month and has to say so.
    unmeasuredDays,
    // Its two parts, which sum back to workedHours rather than adding to it.
    // Derived from the two rounded figures, not rounded independently. The tile prints
    // "normal + ot" beneath the headline and claims they add up; rounding all three separately
    // meant round(a) + round(b) != round(a+b) for 39 of 162 people — PPL-0065 showed a headline of
    // 245.7 over a sub-line reading "229.2 + 16.6", which is 245.8.
    normalHours: Math.round((workedMinutes / 60) * 10) / 10 - Math.round((otMinutes / 60) * 10) / 10,
    otHours: Math.round((otMinutes / 60) * 10) / 10,
    offDayOtHours: Math.round((offDayOtMinutes / 60) * 10) / 10,
    lateMinutes,
    avgLatePerLateDay: lateDays ? Math.round(lateMinutes / lateDays) : 0,
    avgArrival,
    byDow,
  };
}

/**
 * How one day's hours were arrived at, step by step.
 *
 * Asked for after a day read "in 09:37, out 18:51, overtime 5m" and looked wrong. It was not — he
 * was on site 555 minutes, 45 past a full day, and took 79 minutes of break, 39 of them beyond the
 * 40-minute allowance. Net 5. Every number was right and the screen showed none of the ones that
 * mattered, so the only way to check it was to add the punches up by hand.
 *
 * Returns the subtraction as lines, so the day can show its own working. Null when there is nothing
 * to explain — a day off, an absence, or a day with no pair of punches to measure.
 */
/**
 * First punch to last — the whole day, break included.
 *
 * Deliberately the punches rather than check_in/check_out: on a day with a reconstructed punch
 * those are assumed times, and this figure is meant to be only what the terminal recorded.
 */
export function onSiteMinutes(row) {
  const punches = Array.isArray(row?.punches) ? row.punches : [];
  if (punches.length >= 2) {
    const first = new Date(punches[0]).getTime();
    const last = new Date(punches[punches.length - 1]).getTime();
    return Number.isNaN(first) || Number.isNaN(last)
      ? null
      : Math.max(0, Math.round((last - first) / 60_000));
  }
  return null;
}

/**
 * How long the person was actually inside — the day, less every minute they were punched out.
 *
 * This is what "how long was I at work" means to the person asking, and it is not the payable
 * figure: the allowance gives back the first 40 minutes of break, so a day inside for 8 hours is
 * credited 8h40m. Both are true and they answer different questions, which is why the screen now
 * shows both instead of only the payable one.
 *
 * A punch-out here means the person left the building. Somebody who takes lunch at their desk never
 * punches and was genuinely inside the whole time, so a zero break is a real zero, not a missing
 * measurement.
 */
export function insideMinutes(row) {
  const onSite = onSiteMinutes(row);
  return onSite === null ? null : Math.max(0, onSite - (Number(row?.break_minutes) || 0));
}

export function explainDay(row, shift) {
  const punches = Array.isArray(row?.punches) ? row.punches : [];
  if (punches.length < 2) return null;

  const first = new Date(punches[0]).getTime();
  const last = new Date(punches[punches.length - 1]).getTime();
  const onSite = Math.max(0, Math.round((last - first) / 60_000));

  const allowance = Number(shift?.break_minutes) || 0;
  const measured = mins(row.break_minutes);
  const charged = Math.max(0, measured - allowance);
  const worked = mins(row.worked_minutes);
  const fullDay = Number(shift?.full_day_minutes) || 0;
  const ot = mins(row.ot_minutes);

  // The day as a ledger that adds up, in the order somebody actually asks about it: how long was
  // the day, how much of it was I out, how long was I therefore INSIDE, and only then what am I
  // credited. The middle figure is the one people mean by "how long was I at work" and it used to
  // be missing entirely — the old breakdown went straight from time on site to the payable number,
  // subtracting only the break beyond the allowance, so a 60-minute lunch showed as 20 minutes and
  // there was no line anywhere saying you were out for an hour.
  const insideMins = Math.max(0, onSite - measured);
  const free = Math.min(measured, allowance);

  const lines = [{ label: 'On site, first punch to last', minutes: onSite }];

  if (measured > 0) {
    const breaks = Math.max(1, Math.floor((punches.length - 2) / 2));
    lines.push({
      label: `Out of the office (${breaks} break${breaks === 1 ? '' : 's'})`,
      minutes: -measured,
    });
    // Marked `subtotal`, not `total`: `total` is the payable figure and one caller looks for the
    // first line carrying it.
    lines.push({ label: 'Inside the office', minutes: insideMins, subtotal: true });
    lines.push({
      label: `Break allowance — ${free} of the ${measured} min is free`,
      minutes: free,
      muted: charged === 0,
    });
  }

  // An odd punch count leaves one stretch of the day unclassifiable, and the total is then a floor
  // rather than a measurement. Saying so next to the number is the point: without it, a day where
  // somebody punched for a break and then went home without punching reads as a complete short day.
  if (row.breaks_incomplete) {
    lines.push({
      label: 'A punch is missing, so one stretch is unaccounted for',
      minutes: null,
      muted: true,
    });
  }

  lines.push({
    label: row.breaks_incomplete ? 'Counted as worked (at least)' : 'Counted as worked',
    minutes: worked,
    total: true,
  });

  if (fullDay > 0) {
    // On a day off every minute is overtime, whatever the total. Printing "A full day 8h30m" and
    // then "Overtime, beyond a full day 7h47m" underneath it — which is what a worked Sunday did —
    // states two things that cannot both be true, in four consecutive lines, on the very breakdown
    // that exists so a disputed day can be checked by hand. 39 weekly-off days in July render this.
    const isOffDay = ['weekly_off', 'holiday'].includes(
      String(row.day_type ?? '').toLowerCase().replace(/[\s-]+/g, '_')
    );
    if (isOffDay) {
      if (ot > 0) {
        lines.push({
          label: 'Overtime — every minute on a day off counts',
          minutes: ot,
          total: true,
        });
      }
    } else {
      lines.push({ label: 'A full day', minutes: fullDay, muted: true });
      lines.push({
        label: ot > 0 ? 'Overtime, beyond a full day' : 'Short of a full day',
        minutes: ot > 0 ? ot : worked - fullDay,
        total: true,
      });
    }
  }

  // Which punch is missing cannot be recovered from the record, so the note names both readings
  // rather than picking one. It matters which: one means the hours are too low, the other means the
  // break was never measured and they may be too high.
  const missingPunchNote = row.breaks_incomplete
    ? 'An odd number of punches: either the last punch is a break you returned from and the '
      + 'home-time punch is missing — so the hours are lower than the day worked — or it is the '
      + 'home-time punch and a return-from-break is missing, so a break went unmeasured. Raise a '
      + 'correction to set the real time.'
    : null;

  return {
    lines,
    note:
      missingPunchNote
      ?? (charged > 0 && ot >= 0
        ? `${charged} min of break beyond the ${allowance}-minute allowance came off, so the overtime is ${charged} min lower than the time on site suggests.`
        : null),
    incomplete: Boolean(row.breaks_incomplete),
  };
}

/** "8h 35m" / "-39m" — signed, for a column of subtractions. */
export function asHoursMinutes(minutes) {
  const n = Math.round(Number(minutes) || 0);
  const sign = n < 0 ? '−' : '';
  const a = Math.abs(n);
  if (a < 60) return `${sign}${a}m`;
  return `${sign}${Math.floor(a / 60)}h ${a % 60}m`;
}
