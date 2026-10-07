import test from 'node:test';
import assert from 'node:assert/strict';
import { shiftFormDraft, shiftReachability, normalizeShiftForm, shiftBreakSchedule } from './shiftForm.js';

const day = patch => shiftFormDraft({ code: 'DAY', name: 'Day shift', start_time: '09:00', end_time: '17:30',
  break_minutes: 40, break_policy: 'excess', full_day_minutes: 510, half_day_minutes: 255, ...patch });

test('paid allowance and actual breaks permit the whole scheduled window; fixed unpaid policies subtract it', () => {
  for (const break_policy of ['excess', 'actual']) {
    assert.equal(shiftReachability(day({ break_policy })).max, 510);
    assert.doesNotThrow(() => normalizeShiftForm(day({ break_policy })));
  }
  for (const break_policy of ['fixed', 'actual_over_allowance']) {
    assert.equal(shiftReachability(day({ break_policy })).max, 470);
    assert.throws(() => normalizeShiftForm(day({ break_policy })), /470 minutes/);
    assert.doesNotThrow(() => normalizeShiftForm(day({ break_policy, full_day_minutes: 470 })));
  }
});

test('different starting times retain an 8h30 span and overnight shifts cross into the following day', () => {
  assert.equal(shiftReachability(day({ start_time: '09:30', end_time: '18:00' })).span, 510);
  const night = day({ start_time: '22:00', end_time: '06:30', break_policy: 'fixed', break_minutes: 30, full_day_minutes: 480 });
  assert.deepEqual(shiftReachability(night), { span: 510, max: 480, crossesMidnight: true, ok: true });
  assert.equal(normalizeShiftForm(night).end_time, '06:30');
});

test('editing preserves actual rules, zero values and seconds rather than substituting new defaults', () => {
  const saved = { ...day(), id: 'shift', is_flexible: true, ot_basis: 'worked', missed_punch_policy: 'present',
    break_minutes: 0, grace_in_minutes: 0, grace_out_minutes: 0, short_day_tolerance_minutes: 0,
    min_ot_minutes: 0, ot_after_minutes: 0, late_absent_minutes: 0, early_absent_minutes: 0,
    start_time: '09:00:09', end_time: '17:30:09', weekly_offs: [] };
  const draft = shiftFormDraft(saved), payload = normalizeShiftForm(draft);
  for (const key of ['is_flexible', 'ot_basis', 'missed_punch_policy', 'break_minutes', 'min_ot_minutes', 'short_day_tolerance_minutes', 'start_time', 'end_time']) {
    assert.equal(payload[key], saved[key], key);
  }
  assert.deepEqual(payload.weekly_offs, []);
  assert.equal(Object.hasOwn(payload, 'id'), false);
  assert.equal(Object.hasOwn(payload, 'crosses_midnight'), false);
});

test('shift numbers reject negative, fractional, empty and impossible values before saving', () => {
  for (const patch of [{ break_minutes: '-1' }, { break_minutes: '1.5' }, { grace_in_minutes: '' }, { min_ot_minutes: '1e3' },
    { full_day_minutes: 0 }, { half_day_minutes: 511 }, { short_day_tolerance_minutes: 241 }, { weekly_offs: [7] },
    { break_policy: 'unknown' }, { missed_punch_policy: 'auto' }, { ot_basis: 'late' }, { start_time: '25:00' }, { is_flexible: 'false' }]) {
    assert.throws(() => normalizeShiftForm(day(patch)), JSON.stringify(patch));
  }
});

test('legacy partial update callers do not overwrite unseen modern shift rules', () => {
  const payload = normalizeShiftForm({ id: 'saved', code: 'DAY', name: 'Day', start_time: '09:00', end_time: '17:00' });
  for (const key of ['break_policy', 'is_flexible', 'ot_basis', 'missed_punch_policy', 'late_absent_minutes', 'early_absent_minutes', 'short_day_tolerance_minutes']) {
    assert.equal(Object.hasOwn(payload, key), false, key);
  }
});


test('night break windows cross midnight and subtract only scheduled unpaid time from the daily basis', () => {
  const shift = day({ start_time: '22:00', end_time: '06:30', break_policy: 'scheduled', full_day_minutes: 470,
    break_windows: [
      { label: 'Morning rest', start_time: '05:00', end_time: '05:10', is_paid: false },
      { label: 'Tea', start_time: '23:45', end_time: '00:15', is_paid: true },
      { label: 'Meal', start_time: '02:00', end_time: '02:30', is_paid: false },
    ] });
  const schedule = shiftBreakSchedule(shift);
  assert.equal(schedule.unpaidMinutes, 40);
  assert.equal(schedule.payableMinutes, 470);
  assert.deepEqual(schedule.windows.map(window => [window.label, window.startsNextDay, window.endsNextDay]),
    [['Tea', false, true], ['Meal', true, true], ['Morning rest', true, true]]);
  assert.equal(shiftReachability(shift).max, 470);
  const saved = normalizeShiftForm(shift);
  assert.deepEqual(saved.break_windows.map(window => window.label), ['Tea', 'Meal', 'Morning rest']);
  assert.equal(saved.break_windows[0].end_time, '00:15');
  assert.equal(Object.hasOwn(saved.break_windows[0], 'from'), false);
});

test('break windows must be named, within duty, nonoverlapping and explicitly paid or unpaid', () => {
  const window = { label: 'Meal', start_time: '12:00', end_time: '12:30', is_paid: false };
  for (const break_windows of [[], null, [{ ...window, label: '' }], [{ ...window, is_paid: 'false' }],
    [{ ...window, start_time: '08:30' }], [{ ...window, end_time: '18:00' }], [{ ...window, end_time: '12:00' }],
    [window, { ...window, label: 'Tea', start_time: '12:15', end_time: '12:45' }], Array(17).fill(window)]) {
    assert.throws(() => normalizeShiftForm(day({ break_policy: 'scheduled', full_day_minutes: 480, break_windows })), JSON.stringify(break_windows));
  }
  assert.doesNotThrow(() => normalizeShiftForm(day({ break_policy: 'scheduled', full_day_minutes: 480,
    break_windows: [window, { label: 'Paid rest', start_time: '12:30', end_time: '12:45', is_paid: true }] })));
  assert.throws(() => normalizeShiftForm(day({ break_windows: [{ ...window, start_time: '08:30' }] })), /within the shift/,
    'inactive saved windows must remain valid if the shift times change');
});

test('a shift shorter than a day is required and scheduled break seconds survive editing', () => {
  assert.throws(() => normalizeShiftForm(day({ start_time: '09:00', end_time: '09:00' })), /shorter than 24 hours/);
  const saved = day({ break_policy: 'scheduled', full_day_minutes: 480,
    break_windows: [{ label: 'Meal', start_time: '12:00:09', end_time: '12:30:09', is_paid: false }] });
  assert.deepEqual(normalizeShiftForm(shiftFormDraft(saved)).break_windows, saved.break_windows);
});
