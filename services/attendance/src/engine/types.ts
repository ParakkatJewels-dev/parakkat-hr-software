// Types for the attendance engine.

/** What the calendar says about a date, before any punch is considered. */
export type DayType = 'working' | 'weekly_off' | 'holiday';

/**
 * The computed outcome for one employee-date.
 *
 * `status` is the single headline value; the flags alongside it carry detail that would otherwise
 * force compound statuses like "Present (Late + Early Out)". Reports read the flags; humans read
 * the status.
 */
export type AttendanceStatus =
  | 'Present'
  | 'Absent'
  | 'Half Day'
  | 'Weekly Off'
  | 'Holiday'
  | 'On Leave'
  | 'Missing Punch'
  | 'No Shift';

export interface ShiftDefinition {
  id: string;
  code: string;
  name: string;
  /** 'HH:mm:ss' local clock time. */
  startTime: string;
  endTime: string;
  crossesMidnight: boolean;
  graceInMinutes: number;
  graceOutMinutes: number;
  breakMinutes: number;
  /**
   * How the break is charged. 'fixed' always deducts breakMinutes; 'actual' deducts what was
   * measured; 'actual_over_allowance' deducts the greater of the two.
   */
  breakPolicy: 'fixed' | 'actual' | 'actual_over_allowance' | 'excess';
  /** 0 = Sunday … 6 = Saturday. */
  weeklyOffs: number[];
  fullDayMinutes: number;
  halfDayMinutes: number;
  otAfterMinutes: number;
  minOtMinutes: number;
  /** 'exception' = Missing Punch at half a day; 'present' = full credit (Easy Time Pro's rule). */
  missedPunchPolicy: 'exception' | 'present';
  /** Lateness beyond this is an absence, not a late mark. */
  lateAbsentMinutes: number;
  /**
   * How far under the daily hours a day may fall before it counts as short.
   *
   * Being four minutes short is not an exception. The median day here runs 8h 31m against a
   * 510-minute requirement, so an exact threshold would flag half the company every day and the
   * exceptions list would be ignored inside a week.
   */
  shortDayToleranceMinutes: number;
  /** Leaving this early is an absence, not an early exit. */
  earlyAbsentMinutes: number;
  /** 'schedule' = past the shift end; 'worked' = beyond fullDayMinutes. */
  otBasis: 'schedule' | 'worked';
  /**
   * The employee owes the daily hours, not a fixed start and end.
   *
   * Lateness and early exit are not recorded and the absence escalation does not apply — there is
   * no start time to be late for. startTime and endTime remain meaningful as a frame of reference:
   * they decide which work date a punch belongs to, which end of the day a lone punch is, and what
   * to assume for the unrecorded half of a forgotten punch.
   */
  isFlexible: boolean;
}

export interface PunchRecord {
  id: bigint;
  punchTime: Date;
  punchState: string | null;
  terminalSn: string | null;
  terminalAlias: string | null;
}

export interface LeaveOverlay {
  id: string;
  type: string;
  /** 1 = whole day, 0.5 = half day. */
  dayFraction: number;
  /** Loss of pay: counted as leave, paid as nothing. */
  isLop: boolean;
  isPaid: boolean;
}

export interface DayInput {
  employeeId: string;
  workDate: string;
  shift: ShiftDefinition | null;
  dayType: DayType;
  holidayName: string | null;
  punches: PunchRecord[];
  leave: LeaveOverlay | null;
  /** An approved regularization supplies the missing punch(es) for this date. */
  regularization: { id: string; checkIn: Date | null; checkOut: Date | null } | null;
  /**
   * The instant this result describes. Supplied by the caller, never read from the clock here, so
   * the engine stays pure — the same input still produces the same output.
   *
   * It exists because a day in progress is genuinely a different thing from a finished one. At
   * 10am, somebody who punched in at 09:37 and not since has not forgotten to punch out; they are
   * at work. Without this the engine could not tell the two apart and called both a missing punch,
   * which put every person currently on site into the exceptions list every morning.
   *
   * Omit it for a day that is over, which is the usual case.
   */
  asOf?: Date;
}

export interface DayResult {
  employeeId: string;
  workDate: string;
  shiftId: string | null;
  status: AttendanceStatus;
  dayType: DayType;

  checkIn: Date | null;
  checkOut: Date | null;
  firstPunchAt: Date | null;
  lastPunchAt: Date | null;
  punchCount: number;
  /** Every punch of the day, oldest first, after de-duplication. */
  punches: Date[];
  /** Measured minutes away, from the paired middle punches. Not the shift allowance. */
  breakMinutes: number;
  /** The middle punches did not pair up, so breakMinutes is a floor. */
  breaksIncomplete: boolean;

  scheduledIn: Date | null;
  scheduledOut: Date | null;

  workedMinutes: number;
  lateMinutes: number;
  earlyExitMinutes: number;
  otMinutes: number;

  isLate: boolean;
  isEarlyExit: boolean;
  isMissingPunch: boolean;
  /**
   * Attended, finished, and worked more than the tolerance under the daily hours.
   *
   * The headline exception on a flexible shift. Leaving early is otherwise invisible there: no early
   * exit is recorded because there is no fixed end, and short hours do not demote the day, so the
   * only trace was that the hours were low — which nothing was looking at. 7708 such days existed
   * with no flag on any of them.
   */
  isShortDay: boolean;
  /** The break ran past the allowance, so the excess was deducted from worked time. */
  isLongBreak: boolean;

  leaveId: string | null;
  leaveType: string | null;
  isLop: boolean;

  /** Payable credit: 1, 0.5 or 0. Payroll sums this. */
  dayFraction: number;

  regularizationId: string | null;
  source: 'device' | 'manual' | 'regularized' | 'leave' | 'holiday' | 'seed';
  remarks: string | null;
  hours: number;
}
