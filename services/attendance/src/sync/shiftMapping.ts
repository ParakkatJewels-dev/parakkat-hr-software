// Translating Easy Time Pro's timetable vocabulary into ours.
//
// Kept apart from the script that uses it so it can be tested without a terminal, a database or a
// network. Importing the script would run it — it calls main() at load — which is how a unit test
// ended up spending three minutes trying to dial a firewalled LAN address.
//
// FIELD NAMES MOVE BETWEEN BUILDS, so every value is read from the first of several candidate
// fields, and anything unrecognised is reported rather than silently defaulted. A misread grace
// period relabels people as late for months; a misread break changes everyone's paid hours.

export type Rec = Record<string, unknown>;

export interface MappedShift {
  source: string;
  name?: string;
  startTime?: string;
  endTime?: string;
  workMinutes?: number;
  breakMinutes?: number;
  graceIn?: number;
  graceOut?: number;
  minOt?: number;
  /** Fields present on the record that nothing here knows how to read. */
  unread: string[];
}

/** Pull the item list out of whichever envelope this build uses. */
export function itemsOf(body: unknown): Rec[] {
  if (Array.isArray(body)) return body as Rec[];
  const b = body as { data?: unknown; results?: unknown };
  if (Array.isArray(b?.data)) return b.data as Rec[];
  if (Array.isArray(b?.results)) return b.results as Rec[];
  return [];
}

/** First present, non-empty value among several possible field names. */
function pick(rec: Rec, names: string[]): unknown {
  for (const n of names) {
    const v = rec[n];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

const num = (v: unknown): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** '09:30' / '09:30:00' / 570 (minutes past midnight) -> 'HH:mm:ss'. Undefined if unreadable. */
export function asClock(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number' && Number.isFinite(v)) {
    const m = ((v % 1440) + 1440) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
  }
  const m = String(v).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return undefined;
  return `${m[1]!.padStart(2, '0')}:${m[2]}:${m[3] ?? '00'}`;
}

export const addMinutes = (clock: string, minutes: number): string => {
  const [h, m] = clock.split(':').map(Number);
  const t = (((h! * 60 + m! + minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}:00`;
};

/** Minutes from start to end, wrapping past midnight for a night shift. */
export function spanMinutes(startTime: string, endTime: string): number {
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  let mins = eh! * 60 + em! - (sh! * 60 + sm!);
  if (mins <= 0) mins += 1440;
  return mins;
}

const KNOWN = new Set([
  'id', 'alias', 'name', 'shift_name', 'time_name', 'code', 'use_mode', 'update_time',
  'in_time', 'start_time', 'check_in', 'out_time', 'end_time', 'check_out',
  'work_time_duration', 'duration', 'work_day', 'day_type',
  'rest_time', 'break_time', 'use_rest_time', 'rest_time_mode',
  'late_in', 'in_above_margin', 'allow_late', 'early_out', 'out_ahead_margin', 'allow_leave_early',
  'in_ahead_margin', 'out_above_margin', 'min_ot', 'overtime_level', 'available_interval',
  'auto_overtime', 'enable_overtime', 'multiply_wage', 'weekend', 'day_off', 'shift_cycle',
  'cycle_unit', 'period_start', 'company', 'work_type',
]);

/** Translate one Easy Time Pro record into our vocabulary. */
export function mapRecord(rec: Rec, source: string): MappedShift {
  const startTime = asClock(pick(rec, ['in_time', 'start_time', 'check_in']));
  const workMinutes = num(pick(rec, ['work_time_duration', 'duration']));
  let endTime = asClock(pick(rec, ['out_time', 'end_time', 'check_out']));
  // Many builds store only a start plus a duration; derive the end so the two always agree.
  if (!endTime && startTime && workMinutes !== undefined) endTime = addMinutes(startTime, workMinutes);

  // A rest_time of 60 with use_rest_time false means the hour exists on paper and is never
  // deducted. Reading rest_time regardless would quietly shorten everybody's day by an hour.
  const usesRest = pick(rec, ['use_rest_time']);
  const restMinutes = num(pick(rec, ['rest_time', 'break_time']));

  return {
    source,
    name: (pick(rec, ['alias', 'name', 'shift_name', 'time_name']) as string) || undefined,
    startTime,
    endTime,
    workMinutes,
    breakMinutes: usesRest === false || usesRest === 0 ? 0 : restMinutes,
    graceIn: num(pick(rec, ['late_in', 'in_above_margin', 'allow_late'])),
    graceOut: num(pick(rec, ['early_out', 'out_ahead_margin', 'allow_leave_early'])),
    minOt: num(pick(rec, ['min_ot'])),
    unread: Object.keys(rec).filter((k) => !KNOWN.has(k)),
  };
}
