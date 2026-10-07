// Shift configuration mirrors the attendance engine; it never calculates payroll.
export const MAX_SHIFT_BREAK_WINDOWS = 16;
export const BREAK_POLICIES = [
  { value: 'scheduled', label: 'Breaks at scheduled times', help: 'Unpaid break windows are deducted only while the employee is on duty. Recorded time away outside the listed windows is also unpaid. Recorded time away inside paid windows is paid; unpaid windows are never deducted twice.' },
  { value: 'fixed', label: 'Fixed unpaid break', minutesLabel: 'Unpaid break (min)', help: 'Deduct this fixed break from each worked day, even when no break punches were recorded.' },
  { value: 'actual', label: 'Actual punched breaks', minutesLabel: 'Fallback break (min)', help: 'Deduct paired break punches. With only check-in and check-out, deduct no break. Use this fallback when the break punches are incomplete.' },
  { value: 'actual_over_allowance', label: 'At least the unpaid allowance', minutesLabel: 'Minimum unpaid break (min)', help: 'Deduct the greater of the recorded break and this minimum unpaid allowance.' },
  { value: 'excess', label: 'Paid allowance; deduct excess', minutesLabel: 'Paid break allowance (min)', help: 'The allowance is paid. Deduct only recorded break time above it; no break punches means no break deduction.' },
];

const inputDefaults = {
  grace_in_minutes: 0, grace_out_minutes: 0, break_minutes: 0, break_policy: 'fixed', break_windows: [], weekly_offs: [0],
  full_day_minutes: 480, half_day_minutes: 240, ot_after_minutes: 0, min_ot_minutes: 0,
  ot_basis: 'schedule', missed_punch_policy: 'exception', late_absent_minutes: 540,
  early_absent_minutes: 540, short_day_tolerance_minutes: 30, is_flexible: false, is_default: false, is_active: true,
};
const modernFields = ['break_windows', 'break_policy', 'ot_basis', 'missed_punch_policy', 'late_absent_minutes', 'early_absent_minutes', 'short_day_tolerance_minutes', 'is_flexible'];
const minuteFields = ['grace_in_minutes', 'grace_out_minutes', 'break_minutes', 'full_day_minutes', 'half_day_minutes',
  'ot_after_minutes', 'min_ot_minutes', 'late_absent_minutes', 'early_absent_minutes', 'short_day_tolerance_minutes'];
const minuteNames = {
  grace_in_minutes: 'Arrival grace', grace_out_minutes: 'Departure grace', break_minutes: 'Break minutes',
  full_day_minutes: 'Daily paid-hours / salary basis', half_day_minutes: 'Half-day threshold', ot_after_minutes: 'OT grace',
  min_ot_minutes: 'Minimum OT', late_absent_minutes: 'Late absence threshold', early_absent_minutes: 'Early departure absence threshold',
  short_day_tolerance_minutes: 'Short-day tolerance',
};

const clock = value => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(String(value ?? ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) + Number(match[3] ?? 0) / 60 : null;
};
const displayClock = value => /^\d{2}:\d{2}:00$/.test(String(value)) ? String(value).slice(0, 5) : value;

export function shiftFormDraft(row) {
  return { ...inputDefaults, code: '', name: '',
    grace_in_minutes: 15, grace_out_minutes: 15, break_minutes: 60, ot_after_minutes: 30, min_ot_minutes: 30,
    ...row, start_time: displayClock(row?.start_time ?? '09:30'), end_time: displayClock(row?.end_time ?? '18:30'),
    weekly_offs: [...(row?.weekly_offs ?? [0])], break_windows: (row?.break_windows ?? []).map(window => ({ ...window,
      start_time: displayClock(window.start_time), end_time: displayClock(window.end_time) })) };
}

export function shiftBreakSchedule(form) {
  const start = clock(form.start_time), end = clock(form.end_time);
  if (start == null || end == null || start === end) throw new Error('Use valid, distinct shift start and end times; a shift must be shorter than 24 hours.');
  const shiftEnd = end + (end < start ? 1440 : 0);
  const windows = form.break_windows === undefined ? [] : form.break_windows;
  if (!Array.isArray(windows) || windows.length > MAX_SHIFT_BREAK_WINDOWS) throw new Error(`Use at most ${MAX_SHIFT_BREAK_WINDOWS} break windows.`);
  if (form.break_policy === 'scheduled' && !windows.length) throw new Error('Add at least one break window for scheduled breaks.');
  const intervals = windows.map((window, index) => {
    if (!window || typeof window !== 'object' || Array.isArray(window)) throw new Error(`Break ${index + 1} must have a label and valid times.`);
    const label = String(window.label ?? '').trim();
    if (!label || label.length > 100) throw new Error(`Break ${index + 1} needs a label of 1 to 100 characters.`);
    if (typeof window.is_paid !== 'boolean') throw new Error(`Choose whether ${label} is paid.`);
    const from = clock(window.start_time), to = clock(window.end_time);
    if (from == null || to == null) throw new Error(`Enter valid start and end times for ${label}.`);
    const absoluteStart = from + (from < start ? 1440 : 0);
    let absoluteEnd = to + (to < start ? 1440 : 0);
    if (absoluteEnd <= absoluteStart) absoluteEnd += 1440;
    if (absoluteStart < start || absoluteEnd > shiftEnd || absoluteEnd <= absoluteStart) throw new Error(`${label} must fit entirely within the shift.`);
    return { label, start_time: window.start_time, end_time: window.end_time, is_paid: window.is_paid,
      from: absoluteStart, to: absoluteEnd, startsNextDay: absoluteStart >= 1440, endsNextDay: absoluteEnd >= 1440 };
  }).sort((a, b) => a.from - b.from);
  for (let index = 1; index < intervals.length; index += 1) {
    if (intervals[index].from < intervals[index - 1].to) throw new Error(`${intervals[index - 1].label} and ${intervals[index].label} overlap. Keep separate break windows.`);
  }
  const unpaidMinutes = intervals.reduce((sum, window) => sum + (window.is_paid ? 0 : window.to - window.from), 0);
  return { windows: intervals, unpaidMinutes, payableMinutes: shiftEnd - start - unpaidMinutes };
}

export function shiftReachability(form) {
  if (!form) return { ok: true, max: 0, span: 0, crossesMidnight: false };
  const start = clock(form.start_time), end = clock(form.end_time);
  if (start == null || end == null) return { ok: false, max: 0, span: 0, crossesMidnight: false };
  const crossesMidnight = end <= start;
  const span = end - start + (crossesMidnight ? 1440 : 0);
  let fixedDeduction = ['fixed', 'actual_over_allowance'].includes(form.break_policy ?? 'fixed') ? Number(form.break_minutes ?? 0) : 0;
  try {
    const schedule = shiftBreakSchedule(form);
    if (form.break_policy === 'scheduled') fixedDeduction = schedule.unpaidMinutes;
  } catch (error) { return { span, max: 0, crossesMidnight, ok: false, error: error.message }; }
  const max = span - fixedDeduction;
  return { span, max, crossesMidnight, ok: Number.isFinite(max) && Number(form.full_day_minutes ?? 480) <= max };
}

export function normalizeShiftForm(input) {
  const row = { ...inputDefaults, ...input };
  const code = String(row.code ?? '').trim(), name = String(row.name ?? '').trim();
  if (!code || !name) throw new Error('Enter a shift code and name.');
  if (clock(row.start_time) == null || clock(row.end_time) == null) throw new Error('Enter valid shift start and end times.');
  if (!BREAK_POLICIES.some(policy => policy.value === row.break_policy)) throw new Error('Choose a break deduction rule.');
  if (!['schedule', 'worked'].includes(row.ot_basis)) throw new Error('Choose how overtime is measured.');
  if (!['exception', 'present'].includes(row.missed_punch_policy)) throw new Error('Choose the missing-punch credit rule.');
  for (const key of minuteFields) {
    const value = row[key];
    if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(String(value)) || Number(value) > 2147483647) {
      throw new Error(`${minuteNames[key]} must be whole, nonnegative minutes.`);
    }
    row[key] = Number(value);
  }
  if (row.full_day_minutes <= 0) throw new Error('Daily paid-hours / salary basis must be greater than zero.');
  if (row.half_day_minutes > row.full_day_minutes) throw new Error('Half-day threshold cannot exceed the daily paid-hours basis.');
  if (row.short_day_tolerance_minutes > 240) throw new Error('Short-day tolerance must be between 0 and 240 minutes.');
  if (!Array.isArray(row.weekly_offs) || row.weekly_offs.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error('Choose valid weekly off days.');
  const schedule = shiftBreakSchedule(row);
  const reachable = shiftReachability(row);
  if (!reachable.ok) throw new Error(`The daily paid-hours basis exceeds the ${reachable.max} minutes available under this shift’s break rule.`);
  for (const key of ['is_flexible', 'is_default', 'is_active']) if (typeof row[key] !== 'boolean') throw new Error('Choose valid shift options.');
  const payload = { entity_id: row.entity_id || null, code, name, start_time: row.start_time, end_time: row.end_time,
    ...Object.fromEntries(minuteFields.map(key => [key, row[key]])), break_policy: row.break_policy,
    break_windows: schedule.windows.map(({ label, start_time, end_time, is_paid }) => ({ label, start_time, end_time, is_paid })),
    ot_basis: row.ot_basis, missed_punch_policy: row.missed_punch_policy, weekly_offs: [...new Set(row.weekly_offs)].sort(),
    is_flexible: row.is_flexible, is_default: row.is_default, is_active: row.is_active };
  // Partial callers predating these controls must not overwrite a saved, unseen rule.
  if (input.id) for (const key of modernFields) if (!Object.hasOwn(input, key)) delete payload[key];
  return payload;
}
