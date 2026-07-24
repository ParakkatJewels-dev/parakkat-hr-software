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
  /** 0 = Sunday … 6 = Saturday. */
  weeklyOffs: number[];
  fullDayMinutes: number;
  halfDayMinutes: number;
  otAfterMinutes: number;
  minOtMinutes: number;
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
