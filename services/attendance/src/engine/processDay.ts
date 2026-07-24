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

function emptyResult(input: DayInput): DayResult {
  return {
    employeeId: input.employeeId,
    workDate: input.workDate,
    shiftId: input.shift?.id ?? null,
    status: 'Absent',
    dayType: input.dayType,
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
  if (checkIn && checkOut) {
    const gross = Math.max(0, minutesBetween(checkIn, checkOut));
    result.workedMinutes = Math.max(0, gross - shift.breakMinutes);
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
  const overBy = minutesBetween(result.scheduledOut!, checkOut) - shift.otAfterMinutes;
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
