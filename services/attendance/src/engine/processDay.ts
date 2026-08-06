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
import type { DayInput, DayResult, LeaveOverlay, PunchRecord, ShiftDefinition } from './types';

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

  // A shift that stays inside one calendar day takes the whole calendar day, not the schedule plus
  // a margin.
  //
  // The margin left a gap. GENERAL is 09:00-17:30, so start-6h to end+6h is 03:00-23:30, and the
  // next day's window does not open until 03:00 either — a punch between 23:30 and 03:00 belonged
  // to no work date and was silently dropped after being loaded. 41 punches across 6 people, and it
  // does not fail quietly: Vishnu Sathyan (HO90-D4052) punched at 23:34, 23:52 and 23:37 on three
  // January days, each his only punch that day, and all three days are stored Absent with zero
  // minutes. Amal Mohanachandran works 18:15-23:15 and lost a 23:37 exit, which turned a measured
  // 319-minute evening into a reconstructed 510-minute day.
  //
  // The calendar day is complete and cannot overlap its neighbours, which a widened margin would.
  // The margin still applies to a night shift, where the window genuinely spans two dates and the
  // 05:50 exit has to be credited to the day the shift started.
  const { start, end } = scheduledWindow(workDate, shift);
  if (!shift.crossesMidnight) {
    // The day runs from MARGIN before the shift starts to the same instant the next day, so
    // consecutive windows meet exactly and nothing falls between them.
    //
    // Two earlier attempts were both wrong, in opposite directions. The original was
    // `start - 6h .. end + 6h`, which for GENERAL is 03:00-23:30 — and since the next day also
    // opened at 03:00, a punch between 23:30 and 03:00 belonged to no date at all and was dropped
    // after being loaded. Vishnu Sathyan's 23:34, 23:52 and 23:37 punches vanished and those days
    // are stored Absent.
    //
    // Replacing it with the plain calendar day closed the gap but moved the boundary to midnight,
    // which splits a late evening in half: a 00:00:35 exit is the PREVIOUS evening's, and filing it
    // under the new date made it that day's arrival. Replaying history, 38 employee-days became
    // absurd — one read 00:00:35 to 23:50 as a single 23h50m day and paid 920 minutes of overtime.
    //
    // Keeping the lower bound and carrying it forward a full day fixes both: complete, because the
    // next window begins where this one ends; non-overlapping, for the same reason; and a
    // post-midnight punch stays with the evening it belongs to, because 00:00:35 is still inside
    // the window that opened at 03:00 the previous morning.
    const from = new Date(start.getTime() - WINDOW_MARGIN_MINUTES * 60_000);
    return { from, to: new Date(from.getTime() + 24 * 60 * 60_000) };
  }
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

/** Full-day leave conflicts with any real terminal attendance; half-day leave expects punches. */
export function fullDayLeaveConflictsWithPunch(
  leave: LeaveOverlay | null,
  punches: PunchRecord[]
): leave is LeaveOverlay {
  return leave !== null && leave.dayFraction >= 1 && punches.length > 0;
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
    isShortDay: false,
    isLongBreak: false,
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

/**
 * Minutes to subtract from time-on-site for the break. How the break is costed is a company
 * decision, not this function's:
 *
 *   fixed                 deduct the standard allowance whatever actually happened.
 *   actual                deduct the measured time away.
 *   actual_over_allowance deduct the greater of the two — the standard break is theirs whether
 *                         they use it or not, and only an overrun is charged.
 *   excess                deduct only what runs past the allowance.
 *
 * The last is what this company runs. Note the difference in how each treats an unreliable
 * measurement. `actual` deducts a number it knows is short, so it falls back to the allowance
 * rather than overpaying quietly. `actual_over_allowance` can use the measurement even when a
 * punch is missing: what was measured is genuinely time away, and since it can only ever
 * understate the truth, taking the greater of it and the allowance never over-deducts. That also
 * closes the obvious hole — skipping a punch would otherwise buy back a long lunch.
 *
 * Lives outside processDay so the reconstructed single-punch day below is costed by exactly the
 * same rule as a fully punched one, and the two cannot drift apart.
 */
function breakDeduction(
  shift: ShiftDefinition,
  measurement: { breakMinutes: number; breaksIncomplete: boolean }
): number {
  // Two punches — in and out, nothing between — is not a missing measurement. It is a day somebody
  // worked straight through, and here that is the common case: of 602 completed days, 440 carry
  // exactly two punches. Charging each the standard hour deducted 440 hours for breaks nobody took.
  //
  // A break is only unmeasurable when the punches contradict themselves, i.e. an odd number of
  // middle punches means one of a pair was missed. Then, and only then, is the allowance the safer
  // number.
  const canMeasure = !measurement.breaksIncomplete;
  const measured = measurement.breakMinutes;

  switch (shift.breakPolicy) {
    case 'actual':
      // What the punches say, including nothing.
      return canMeasure ? measured : shift.breakMinutes;

    case 'actual_over_allowance':
      return Math.max(shift.breakMinutes, measured);

    case 'excess':
      // The allowance costs nothing; only the minutes beyond it are charged. A 20-minute tea break
      // inside a 30-minute allowance is free, a 62-minute lunch costs 32.
      //
      // Nothing punched means nothing deducted, deliberately. Only 11% of days here carry a break
      // punch at all, so treating "no punch" as "took the full allowance" would dock tens of
      // thousands of hours on no evidence. An incomplete measurement understates the break, so it
      // can only ever under-deduct — which is the right direction to be wrong in.
      return Math.max(0, measured - shift.breakMinutes);

    default:
      return shift.breakMinutes;
  }
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
  // Time on site, less the break as the company's policy costs it. See breakDeduction above.
  if (checkIn && checkOut) {
    const gross = Math.max(0, minutesBetween(checkIn, checkOut));
    result.workedMinutes = Math.max(0, gross - breakDeduction(shift, result));
    result.hours = minutesToHours(result.workedMinutes);
  }

  // --- leave overrides the punch story ----------------------------------------
  // Full-day punch conflicts are reconciled by recompute before they reach this pure rule. A
  // full-day overlay here therefore has no attendance, while half-day leave deliberately falls
  // through because punching is expected for the worked half.
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

    // Worked on a day off? Every minute is overtime, and the day reads as PRESENT.
    //
    // The status used to stay 'Weekly Off' whatever the punches said. 594 days on which people
    // actually came in were therefore indistinguishable from the 7,700-odd spent at home: both drew
    // a 'W' in the calendar, and the monthly "present" count left them out. The hours and the
    // overtime were on the record, but you had to open the day to discover anyone had been there,
    // which is not where you look when you are asking whether you were credited for working Sunday.
    //
    // Present is also what this shift does on every other day. GENERAL is flexible, and the rule
    // further down is "turning up settles the day" — full credit, short hours flagged rather than
    // docked. A rest day somebody chose to work should not be scored more harshly than a Tuesday.
    //
    // PAY DOES NOT MOVE. dayFraction was already 1 for the rest day and stays 1, so payable_days is
    // untouched. `day_type` still records that the day WAS an off day, so nothing downstream loses
    // the distinction — a report can still ask who is working weekends. And overtime still counts
    // every minute rather than only those past a full day, because nothing was scheduled: there is
    // no normal length for the day to be over.
    //
    // Both punches required. A lone punch stays a flagged exception below for the reason given
    // there — the hours cannot be measured, and Present on an unmeasurable day would be a guess
    // dressed as a fact. Regularizing it supplies the times, and then this branch marks it Present.
    if (checkIn && checkOut) {
      result.status = 'Present';
      if (result.workedMinutes >= shift.minOtMinutes) {
        result.otMinutes = result.workedMinutes;
      }
      result.remarks = [result.remarks, `Worked on ${dayType === 'holiday' ? 'holiday' : 'weekly off'}`]
        .filter(Boolean)
        .join(' — ');
    }

    // Exceptions are recorded on a day off too.
    //
    // This branch used to return before the flags further down were set, so a day off was the one
    // place an incomplete record could not say it was incomplete — while being the place it matters
    // most, because every minute here is paid as overtime. In July 2026 seven weekly-off days
    // carried 48.7 hours of overtime on records the engine itself scored `breaksIncomplete`, and no
    // exceptions report could filter for them. Eleven more had a break past the allowance whose
    // excess WAS deducted from the paid overtime, while the field that exists to explain exactly
    // that said nothing.
    result.isLongBreak = result.breakMinutes > shift.breakMinutes;

    // A lone punch on a day off is flagged rather than reconstructed. A working day rebuilds the
    // missing half from the schedule, which cannot be right here: nobody was scheduled, so there is
    // no shape to rebuild from, and inventing 8h30m of overtime on one button press would be the
    // most expensive guess in the engine. Crediting nothing is the safe direction — but it was also
    // silent, so 129 days across 38 people showed a rest day with no hint anyone had been in.
    // Flagged, HR can regularize it and set the real time.
    if (result.punchCount === 1 || (result.punchCount >= 3 && result.punchCount % 2 === 1)) {
      result.isMissingPunch = true;
      result.remarks = [
        result.remarks,
        result.punchCount === 1
          ? 'Punched once on a day off — the hours cannot be measured, so none are credited'
          : 'A punch is missing — one stretch of the day is unaccounted for',
      ]
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
  // demonstrably was here. It is an exception for HR to regularize.
  //
  // But WHICH end of the day is it? Treating every lone punch as an arrival is wrong half the
  // time. People here forget to punch out in the morning group and forget to punch in in the
  // evening group, and both happen a lot: of 184 such days, 101 held a morning punch and 75 an
  // evening one. Recording an evening punch as an arrival produced things like
  //
  //   Narayanan.C.K  17:31  ->  "arrived, 466 minutes late"
  //
  // on four separate days. He was not late; that punch is him going home. All 75 were flagged
  // late, averaging 473 minutes, which is a fabricated disciplinary record.
  //
  // The scheduled midpoint separates the two cleanly — the real punches cluster around 08:00-09:00
  // and 17:00-18:00, nowhere near it — and where there is no shift to compare against, the old
  // assumption stands rather than a guess.
  if (!checkOut) {
    const midpoint = new Date(
      (result.scheduledIn!.getTime() + result.scheduledOut!.getTime()) / 2
    );
    const isDeparture = checkIn.getTime() > midpoint.getTime();

    // --- is the day simply not over yet? -----------------------------------------------------
    //
    // Somebody who punched in at 09:37 and not since has not forgotten to punch out at 10am. They
    // are at work. Everything below this point assumes the day is finished and the second punch is
    // never coming, and applying it to a day still in progress got two things wrong at once:
    //
    //   it called every person currently on site an exception, so the exceptions list filled up
    //   with the whole company every morning and emptied itself by evening
    //
    //   it credited them to the shift end — 09:37 with one punch was booked as 473 minutes, a
    //   full day's hours, at ten in the morning
    //
    // The rule the company asked for, and the obvious one: it is only a missing punch once the
    // shift has ended. Until then the hours are what they have actually been here, and the day is
    // not an exception because nothing has gone wrong yet.
    const asOf = input.asOf;
    const stillInShift =
      asOf !== undefined && !isDeparture && asOf.getTime() < result.scheduledOut!.getTime();

    if (stillInShift && asOf) {
      result.status = 'Present';
      result.isMissingPunch = false;
      result.checkOut = null;

      // Time on site so far, not time they are expected to put in. Overtime is deliberately left
      // at zero: nobody has worked beyond a full day until the day is done, and paying it out
      // mid-morning on a projection would be inventing a claim.
      const soFar = Math.max(0, minutesBetween(checkIn, asOf));
      result.workedMinutes = Math.max(0, soFar - breakDeduction(shift, result));
      result.hours = minutesToHours(result.workedMinutes);
      result.dayFraction = Math.max(result.dayFraction, 1);
      result.remarks = 'On site — has not punched out yet';

      if (!shift.isFlexible) {
        const lateBy = minutesBetween(result.scheduledIn!, checkIn) - shift.graceInMinutes;
        if (lateBy > 0) {
          result.lateMinutes = lateBy;
          result.isLate = true;
        }
      }
      return result;
    }

    result.isMissingPunch = true;

    // Easy Time Pro credits a forgotten punch as Present ("Calculate Missed Check-In/Out as
    // Present"), and that is the rule this company runs on. The person demonstrably came to work;
    // pressing the button once instead of twice is an administrative slip, not half a day off.
    // The day stays flagged either way, so HR can still see and correct it — only the credit and
    // the label differ.
    const creditAsPresent = shift.missedPunchPolicy === 'present';
    result.status = creditAsPresent ? 'Present' : 'Missing Punch';

    // The hours are measured from the punch that exists to the scheduled boundary on the side that
    // is missing. This is Easy Time Pro's rule, verified against its own Monthly Status Report:
    // clipping the punch window to the 09:00-17:30 schedule reproduces its Total WK on 2703 of 2703
    // employee-days, single-punch days included. It is emphatically NOT "credit a full day" —
    //
    //   Narayanan CK  day 5   in 12:45, never out  ->  4:45
    //   Narayanan CK  day 28  in 09:16, never out  ->  8:14
    //   Narayanan CK  day 21  out 17:06, never in  ->  8:06
    //
    // — the day is worth what the real punch says. Day 1's 8:30 only looks like a full day because
    // he happened to leave at the normal time.
    //
    // This is the one place the engine adopts their model wholesale instead of its own. Everywhere
    // else we count real time on site and pay the overflow as overtime; here we cannot, because
    // half the interval was never measured.
    //
    // Scoring these zero, as this did before, silently left 196 days across 109 people unpaid in
    // July alone.
    //
    // The schedule supplies the missing side, and it also bounds the recorded one. Without that
    // second clamp a lone 22:00 punch would credit thirteen hours off a single press of the
    // button — a bigger hole than the one being closed. On a day that is half assumption, nothing
    // outside the scheduled window is payable.
    const from = isDeparture
      ? result.scheduledIn!
      : new Date(Math.max(checkIn.getTime(), result.scheduledIn!.getTime()));
    const to = isDeparture
      ? new Date(Math.min(checkIn.getTime(), result.scheduledOut!.getTime()))
      : result.scheduledOut!;

    const gross = Math.max(0, minutesBetween(from, to));
    result.workedMinutes = Math.max(0, gross - breakDeduction(shift, result));
    result.hours = minutesToHours(result.workedMinutes);

    if (isDeparture) {
      // The one thing known is when they left. When they arrived is not recorded, so no lateness
      // is asserted — claiming someone was eight hours late for forgetting to punch in is worse
      // than recording nothing.
      result.checkIn = null;
      result.checkOut = checkIn;
      result.remarks = 'Only one punch recorded — no check-in, hours counted from the shift start';
    } else {
      result.remarks = 'Only one punch recorded — no check-out, hours counted to the shift end';

      // No lateness on a flexible shift; see the lateness block further down.
      if (!shift.isFlexible) {
        const lateBy = minutesBetween(result.scheduledIn!, checkIn) - shift.graceInMinutes;
        if (lateBy > 0) {
          result.lateMinutes = lateBy;
          result.isLate = true;
        }
      }
    }

    // No overtime, whatever the numbers say. Half of this day is an assumption, and an assumption
    // must not generate a payable claim — otherwise forgetting to punch out becomes profitable.
    // Falling out of this branch before the overtime block is what enforces that.
    //
    // A full day under Easy Time Pro's rule; half pending regularization under ours.
    result.dayFraction = Math.max(result.dayFraction, creditAsPresent ? 1 : 0.5);
    return result;
  }

  // --- lateness and early exit ---------------------------------------------------
  // Neither exists on a flexible shift. What is owed is the daily hours, and the verdict below
  // already measures exactly that; arriving at 10:00 and leaving at 18:30 is a full day, not a
  // late mark and an overtime claim.
  //
  // This is where our answer and Easy Time Pro's part company on purpose. Every employee sits on
  // its General Time Table, so it grades all 163 against a 09:00 start and reported 1780 late days
  // in July — 1113 hours of "lateness" that is not lateness under the policy the company actually
  // runs. Recording it anyway would build a disciplinary record out of a setting nobody chose.
  if (!shift.isFlexible) {
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
  }

  // --- overtime -------------------------------------------------------------------
  // 'schedule' counts time visible after the shift ends; 'worked' counts work beyond a full day,
  // which is the only one of the two that notices somebody who started ninety minutes early.
  // Whichever basis, the same two thresholds apply: otAfterMinutes is grace before the meter
  // starts, minOtMinutes is the floor below which a claim is not worth recording.
  // A flexible shift can only be measured against hours worked. A schedule basis would pay the
  // person who drifts in late and stays late, and pay nothing to the person who starts at 07:00
  // and leaves at 17:00 having worked longer — on a shift whose whole premise is that the start
  // time is theirs to choose.
  const beyond =
    shift.otBasis === 'worked' || shift.isFlexible
      ? result.workedMinutes - shift.fullDayMinutes
      : minutesBetween(result.scheduledOut!, checkOut);

  const overBy = beyond - shift.otAfterMinutes;
  if (overBy >= shift.minOtMinutes) {
    result.otMinutes = overBy;
  }

  // --- past a point, late is not late any more --------------------------------------
  // Easy Time Pro escalates rather than accumulating: beyond these the day is an absence, not a
  // very large late mark. Someone who appears three hours before closing did not work that day.
  //
  // Skipped outright on a flexible shift rather than left to fall through on zeroed counters: a
  // threshold of 0 would otherwise turn every day into an absence, and there is no lateness here
  // to escalate in the first place. Turning up for two hours is already scored by the hours.
  if (
    !shift.isFlexible &&
    (result.lateMinutes > shift.lateAbsentMinutes || result.earlyExitMinutes > shift.earlyAbsentMinutes)
  ) {
    result.status = 'Absent';
    result.dayFraction = 0;
    result.remarks = [result.remarks,
      result.lateMinutes > shift.lateAbsentMinutes ? 'Late beyond the absence threshold' : 'Left beyond the absence threshold',
    ].filter(Boolean).join(' — ');
    return result;
  }

  // A break past the allowance had time deducted for it — true on any shift, and the figure people
  // query when overtime is smaller than the clock suggests.
  result.isLongBreak = result.breakMinutes > shift.breakMinutes;

  // An odd number of punches means one was missed, and the day was not saying so.
  //
  // isMissingPunch only covered the single-punch case, so a day like 09:00 / 13:00 / 13:30 read as a
  // complete four-and-a-half hour day — indistinguishable from somebody who genuinely worked those
  // hours and went home. 618 days across the history have an odd count.
  //
  // Which punch is missing cannot be known from the record: 62% of these days have more than two
  // hours between the last two punches, so the final punch is a departure and a break-return was
  // missed; 28% have under an hour, so the final punch is a break-return and the departure was
  // missed. Both leave one span of the day unaccounted for, and the flag says so without pretending
  // to know which. The hours are unchanged — what changes is that the day now admits it is a floor.
  if (result.punchCount >= 3 && result.punchCount % 2 === 1) {
    result.isMissingPunch = true;
    result.remarks = [result.remarks, 'A punch is missing — one stretch of the day is unaccounted for']
      .filter(Boolean)
      .join(' — ');
  }

  // --- the verdict ------------------------------------------------------------------
  // On a flexible shift, turning up is what settles the day. Short hours are recorded and stay
  // visible, but they do not dock the day — which is Easy Time Pro's rule, and the company's.
  //
  // Verified against its report rather than assumed: NARAYANAN CK's July header reads
  // "Present: 24, Absent: 4" across 28 days, and his day 5 — clocked in 12:45, 4:45 worked — is
  // one of the 24. Nothing but an empty day counts against him.
  //
  // The alternative demoted 11,230 days to Half Day across 15 months, most of them for finishing
  // a few minutes under 8:30, because the median day here is 8:31 and a hard threshold sits right
  // on top of the distribution. A rule that pays or docks on which side of the median a day lands
  // is a coin toss, not a policy.
  // NOTE: `halfDayMinutes` is not consulted on a flexible shift and cannot be. The shift record
  // still carries 255, which reads like an active control and is not one — an audit flagged 84 July
  // days under that threshold paid in full, the shortest 51 minutes, as though the setting had been
  // ignored by mistake. It has not: on this shift turning up settles the day, by policy. The days
  // are not hidden, they carry `isShortDay`. Left as-is deliberately; changing it would cut pay on
  // 84 days and that is the owner's call, not the engine's. If it is ever made real, do it with an
  // explicit threshold well below the median day rather than by reinstating this one.
  if (shift.isFlexible) {
    result.status = 'Present';
    result.dayFraction = Math.max(result.dayFraction, 1);

    const short = shift.fullDayMinutes - result.workedMinutes;
    // Recorded even though the day is not docked. The two are separate questions: policy says a
    // short day still pays in full, and somebody still needs to see that it happened.
    result.isShortDay = short > shift.shortDayToleranceMinutes;
    if (short > 0) {
      const h = Math.floor(short / 60);
      result.remarks = [result.remarks, `Short of the daily hours by ${h ? `${h}:` : ''}${String(short % 60).padStart(h ? 2 : 1, '0')}${h ? '' : ' min'}`]
        .filter(Boolean)
        .join(' — ');
    }
  } else if (result.workedMinutes >= shift.fullDayMinutes) {
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

  if (!shift.isFlexible) {
    result.isShortDay = result.workedMinutes < shift.fullDayMinutes - shift.shortDayToleranceMinutes;
  }

  // A half-day leave plus a worked half is a full paid day.
  if (input.leave && input.leave.dayFraction === 0.5 && !input.leave.isLop && input.leave.isPaid) {
    result.dayFraction = Math.min(1, 0.5 + Math.max(result.dayFraction, 0.5));
    result.status = 'On Leave';
  }

  return result;
}
