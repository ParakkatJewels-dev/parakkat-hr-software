// The attendance rules — the one place that decides what a day means.
//
// Kept as a pure function on purpose: no database, no clock, no I/O. Everything it needs arrives
// in DayInput. That makes each rule testable in isolation and, more importantly, makes recomputing
// a historical date produce the same answer today as it did last month.
//
// Edge cases handled explicitly (all four called out in the brief):
//   - single punch days      -> Missing Punch, never a silent 0-hour Present
//   - night shifts           -> the punch window follows the shift across midnight
//   - duplicate punches      -> collapsed within PUNCH_DEDUPE_SECONDS
//   - no shift assigned      -> No Shift; the person is NOT marked absent on a guess
import { env } from '../config/env';
import { workDateAtTime, weekdayOf, minutesBetween, minutesToHours } from '../lib/time';
import type { DayInput, DayResult, PunchRecord, ShiftDefinition } from './types';

/** How far either side of the scheduled shift a punch still counts as that shift's punch. */
const WINDOW_MARGIN_MINUTES = 6 * 60;

/** The scheduled start/end instants for a shift on a work date, honouring midnight crossing. */
export function scheduledWindow(
  workDate: string,
  shift: ShiftDefinition
): { start: Date; end: Date } {
  const start = workDateAtTime(workDate, shift.startTime);
  const end = workDateAtTime(workDate, shift.endTime, shift.crossesMidnight ? 1 : 0);
  return { start, end };
}

/**
 * The window of punches belonging to this work date.
 *
 * For a day shift this is close to the calendar day. For a night shift (22:00 -> 06:00) it runs
 * from the evening of the work date into the following morning — which is the whole reason a
 * night-shift worker's 05:50 exit punch is credited to the day they started, not the day after.
 */
export function punchWindow(workDate: string, shift: ShiftDefinition | null): { from: Date; to: Date } {
  if (!shift) {
    return {
      from: workDateAtTime(workDate, '00:00:00'),
      to: workDateAtTime(workDate, '00:00:00', 1),
    };
  }

  const { start, end } = scheduledWindow(workDate, shift);
  return {
    from: new Date(start.getTime() - WINDOW_MARGIN_MINUTES * 60_000),
    to: new Date(end.getTime() + WINDOW_MARGIN_MINUTES * 60_000),
  };
}

/**
 * Collapse punches that are effectively the same event.
 *
 * People double-tap the terminal, and a face reader can fire twice while someone lingers. Two
 * punches 8 seconds apart are one arrival, and left uncollapsed they would show as a 8-second
 * working day for anyone whose only two punches of the day were that double-tap.
 */
export function dedupePunches(punches: PunchRecord[], withinSeconds = env.PUNCH_DEDUPE_SECONDS): PunchRecord[] {
  if (punches.length <= 1) return [...punches];

  const sorted = [...punches].sort((a, b) => a.punchTime.getTime() - b.punchTime.getTime());
  const out: PunchRecord[] = [sorted[0]!];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]!;
    const previous = out[out.length - 1]!;
    const gapSeconds = (current.punchTime.getTime() - previous.punchTime.getTime()) / 1000;
    if (gapSeconds >= withinSeconds) out.push(current);
  }

  return out;
}

/**
 * Split a day's punches into the stretches worked and the stretches away.
 *
 * The terminals here report punch_state 255 on every record — the face readers are not configured
 * to distinguish an entry from an exit — so direction cannot be read off the punch. Order is all
 * there is: the first punch is arrival, the last is departure, and the ones between alternate
 * out, in, out, in. That matches the observed shape of a day exactly:
 *
 *   09:39 [10:38-10:53] [13:02-13:36] [15:36-16:05] 18:33   ->  3 breaks, 78 minutes away
 *
 * An odd number of middle punches means one was missed. The breaks that can still be paired are
 * measured, and `incomplete` is set so nobody treats the total as the whole truth — under-counting
 * break time silently would overpay, which is the failure worth being loud about.
 */
export function splitSessions(punches: Date[]): {
  breaks: { from: Date; to: Date; minutes: number }[];
  breakMinutes: number;
  incomplete: boolean;
} {
  const breaks: { from: Date; to: Date; minutes: number }[] = [];
  if (punches.length < 4) {
    // Fewer than four punches cannot describe a break: two is in/out, three is in/out with one
    // stray that we cannot place.
    return { breaks: [], breakMinutes: 0, incomplete: punches.length === 3 };
  }

  const middle = punches.slice(1, -1);
  for (let i = 0; i + 1 < middle.length; i += 2) {
    const from = middle[i]!;
    const to = middle[i + 1]!;
    breaks.push({ from, to, minutes: Math.max(0, minutesBetween(from, to)) });
  }

  return {
    breaks,
    breakMinutes: breaks.reduce((sum, b) => sum + b.minutes, 0),
    incomplete: middle.length % 2 === 1,
  };
}

function emptyResult(input: DayInput): DayResult {
  return {
    employeeId: input.employeeId,
    workDate: input.workDate,
    shiftId: input.shift?.id ?? null,
    status: 'Absent',
    dayType: input.dayType,
    punches: [],
    breakMinutes: 0,
    breaksIncomplete: false,
    checkIn: null,
    checkOut: null,
    firstPunchAt: null,
    lastPunchAt: null,
    punchCount: 0,
    scheduledIn: null,
    scheduledOut: null,
    workedMinutes: 0,
    lateMinutes: 0,
    earlyExitMinutes: 0,
    otMinutes: 0,
    isLate: false,
    isEarlyExit: false,
    isMissingPunch: false,
    leaveId: null,
    leaveType: null,
    isLop: false,
    dayFraction: 0,
    regularizationId: null,
    source: 'device',
    remarks: null,
    hours: 0,
  };
}

/** Compute one employee-date. Pure. */
export function processDay(input: DayInput): DayResult {
  const result = emptyResult(input);
  const { shift } = input;

  // --- what the calendar says -------------------------------------------------
  const isWeeklyOff = shift ? shift.weeklyOffs.includes(weekdayOf(input.workDate)) : false;
  const dayType = input.dayType === 'holiday' ? 'holiday' : isWeeklyOff ? 'weekly_off' : input.dayType;
  result.dayType = dayType;

  if (shift) {
    const { start, end } = scheduledWindow(input.workDate, shift);
    result.scheduledIn = start;
    result.scheduledOut = end;
  }

  // --- punches ----------------------------------------------------------------
  const deduped = dedupePunches(input.punches);
  result.punchCount = deduped.length;
  result.firstPunchAt = deduped[0]?.punchTime ?? null;
  result.lastPunchAt = deduped.length ? deduped[deduped.length - 1]!.punchTime : null;

  // Keep the whole timeline, not just the ends. Everything after this can explain itself.
  result.punches = deduped.map((p) => p.punchTime);
  const sessions = splitSessions(result.punches);
  result.breakMinutes = sessions.breakMinutes;
  result.breaksIncomplete = sessions.incomplete;

  // An approved regularization supplies what the device missed. It wins over the raw punches for
  // the times it specifies, and only for those.
  let checkIn = result.firstPunchAt;
  let checkOut = deduped.length > 1 ? result.lastPunchAt : null;

  if (input.regularization) {
    result.regularizationId = input.regularization.id;
    if (input.regularization.checkIn) checkIn = input.regularization.checkIn;
    if (input.regularization.checkOut) checkOut = input.regularization.checkOut;
    result.source = 'regularized';
  }

  result.checkIn = checkIn;
  result.checkOut = checkOut;

  // --- no shift: refuse to guess ----------------------------------------------
  // Marking someone absent because nobody assigned them a shift would be an HR data problem
  // masquerading as an attendance fact. Surface it instead.
  if (!shift) {
    result.status = 'No Shift';
    result.remarks = 'No shift assigned for this date';
    if (checkIn && checkOut) {
      result.workedMinutes = Math.max(0, minutesBetween(checkIn, checkOut));
      result.hours = minutesToHours(result.workedMinutes);
    }
    return result;
  }

  // --- worked time ------------------------------------------------------------
  // How the break is costed is a company decision, not this function's:
  //
  //   fixed                 deduct the standard allowance whatever actually happened.
  //   actual                deduct the measured time away.
  //   actual_over_allowance deduct the greater of the two — the standard break is theirs whether
  //                         they use it or not, and only an overrun is charged.
  //
  // The third is what this company runs. Note the difference in how each treats an unreliable
  // measurement. `actual` deducts a number it knows is short, so it falls back to the allowance
  // rather than overpaying quietly. `actual_over_allowance` can use the measurement even when a
  // punch is missing: what was measured is genuinely time away, and since it can only ever
  // understate the truth, taking the greater of it and the allowance never over-deducts. That also
  // closes the obvious hole — skipping a punch would otherwise buy back a long lunch.
  if (checkIn && checkOut) {
    const gross = Math.max(0, minutesBetween(checkIn, checkOut));
    const measured = result.punches.length >= 4 ? result.breakMinutes : 0;

    let deduction: number;
    switch (shift.breakPolicy) {
      case 'actual':
        deduction = measured > 0 && !result.breaksIncomplete ? measured : shift.breakMinutes;
        break;
      case 'actual_over_allowance':
        deduction = Math.max(shift.breakMinutes, measured);
        break;
      default:
        deduction = shift.breakMinutes;
    }

    result.workedMinutes = Math.max(0, gross - deduction);
    result.hours = minutesToHours(result.workedMinutes);
  }

  // --- leave overrides the punch story ----------------------------------------
  // Approved leave decides the day even if a punch exists (someone came in to hand over work on
  // an approved leave day is still on leave).
  if (input.leave) {
    result.leaveId = input.leave.id;
    result.leaveType = input.leave.type;
    result.isLop = input.leave.isLop;
    result.status = 'On Leave';
    result.source = 'leave';
    // LOP is leave without pay: recorded as leave, worth nothing.
    result.dayFraction = input.leave.isLop || !input.leave.isPaid ? 0 : input.leave.dayFraction;
    result.remarks = input.leave.isLop ? 'Loss of pay' : null;

    // A half-day leave still expects half a day of attendance; fall through to the punch rules
    // below only for the worked half.
    if (input.leave.dayFraction >= 1) return result;
  }

  // --- holidays and weekly offs ------------------------------------------------
  if (dayType === 'holiday' || dayType === 'weekly_off') {
    result.status = dayType === 'holiday' ? 'Holiday' : 'Weekly Off';
    result.source = dayType === 'holiday' ? 'holiday' : 'device';
    result.dayFraction = Math.max(result.dayFraction, 1); // paid rest day
    result.remarks = input.holidayName ?? result.remarks;

    // Worked on a day off? Every minute is overtime.
    if (checkIn && checkOut && result.workedMinutes >= shift.minOtMinutes) {
      result.otMinutes = result.workedMinutes;
      result.remarks = [result.remarks, `Worked on ${dayType === 'holiday' ? 'holiday' : 'weekly off'}`]
        .filter(Boolean)
        .join(' — ');
    }
    return result;
  }

  // --- no punches at all --------------------------------------------------------
  if (!checkIn) {
    if (!input.leave) {
      result.status = 'Absent';
      result.dayFraction = 0;
    }
    return result;
  }

  // --- exactly one punch --------------------------------------------------------
  // Deliberately NOT treated as present-with-zero-hours, and not as absent either: the person
  // demonstrably came in. It is an exception for HR to regularize.
  if (!checkOut) {
    result.status = 'Missing Punch';
    result.isMissingPunch = true;
    result.remarks = 'Only one punch recorded';

    const lateBy = minutesBetween(result.scheduledIn!, checkIn) - shift.graceInMinutes;
    if (lateBy > 0) {
      result.lateMinutes = lateBy;
      result.isLate = true;
    }
    // Half credit pending regularization — HR adjusts by approving one.
    result.dayFraction = Math.max(result.dayFraction, 0.5);
    return result;
  }

  // --- lateness and early exit ---------------------------------------------------
  const lateBy = minutesBetween(result.scheduledIn!, checkIn) - shift.graceInMinutes;
  if (lateBy > 0) {
    result.lateMinutes = lateBy;
    result.isLate = true;
  }

  const earlyBy = minutesBetween(checkOut, result.scheduledOut!) - shift.graceOutMinutes;
  if (earlyBy > 0) {
    result.earlyExitMinutes = earlyBy;
    result.isEarlyExit = true;
  }

  // --- overtime -------------------------------------------------------------------
  // 'schedule' counts time visible after the shift ends; 'worked' counts work beyond a full day,
  // which is the only one of the two that notices somebody who started ninety minutes early.
  // Whichever basis, the same two thresholds apply: otAfterMinutes is grace before the meter
  // starts, minOtMinutes is the floor below which a claim is not worth recording.
  const beyond =
    shift.otBasis === 'worked'
      ? result.workedMinutes - shift.fullDayMinutes
      : minutesBetween(result.scheduledOut!, checkOut);

  const overBy = beyond - shift.otAfterMinutes;
  if (overBy >= shift.minOtMinutes) {
    result.otMinutes = overBy;
  }

  // --- the verdict ------------------------------------------------------------------
  if (result.workedMinutes >= shift.fullDayMinutes) {
    result.status = 'Present';
    result.dayFraction = Math.max(result.dayFraction, 1);
  } else if (result.workedMinutes >= shift.halfDayMinutes) {
    result.status = 'Half Day';
    result.dayFraction = Math.max(result.dayFraction, 0.5);
  } else {
    // Present on site but short of a half day. Still "present" for the register — being marked
    // absent on a day you were demonstrably at work causes more disputes than it settles — but
    // the payable fraction reflects the hours.
    result.status = 'Present';
    result.dayFraction = Math.max(result.dayFraction, 0.5);
    result.remarks = [result.remarks, 'Short hours'].filter(Boolean).join(' — ');
  }

  // A half-day leave plus a worked half is a full paid day.
  if (input.leave && input.leave.dayFraction === 0.5 && !input.leave.isLop && input.leave.isPaid) {
    result.dayFraction = Math.min(1, 0.5 + Math.max(result.dayFraction, 0.5));
    result.status = 'On Leave';
  }

  return result;
}
