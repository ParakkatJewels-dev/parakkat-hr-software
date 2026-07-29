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
  breakPolicy: 'fixed' | 'actual' | 'actual_over_allowance';
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
  /** Leaving this early is an absence, not an early exit. */
  earlyAbsentMinutes: number;
  /** 'schedule' = past the shift end; 'worked' = beyond fullDayMinutes. */
  otBasis: 'schedule' | 'worked';
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
