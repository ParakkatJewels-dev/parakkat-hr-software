// Date arithmetic for the attendance period filter.
//
//   node --test src/lib/dateRange.test.js
//
// Worth testing because every failure here is silent: a range that is one day short, or that
// starts in the wrong month, returns real-looking rows and nobody notices until a payroll total
// disagrees with the register.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, addMonths, startOfMonth, rangeFor, RANGE_PRESETS } from './dateRange.js';

test('adding and subtracting days crosses month and year boundaries', () => {
  assert.equal(addDays('2026-07-29', 1), '2026-07-30');
  assert.equal(addDays('2026-07-31', 1), '2026-08-01');
  assert.equal(addDays('2026-08-01', -1), '2026-07-31');
  assert.equal(addDays('2027-01-01', -1), '2026-12-31');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2024-03-01', -1), '2024-02-29', 'a leap year');
});

test('three months back from a 31st clamps instead of rolling into the next month', () => {
  // The bug this exists to prevent: 31 February does not exist, and JavaScript resolves it to
  // 2 or 3 March, which would start "last 3 months" in the wrong month entirely.
  assert.equal(addMonths('2026-05-31', -3), '2026-02-28');
  assert.equal(addMonths('2024-05-31', -3), '2024-02-29', 'leap year');
  assert.equal(addMonths('2026-07-31', -3), '2026-04-30');
  // Ordinary days are untouched.
  assert.equal(addMonths('2026-07-29', -3), '2026-04-29');
  assert.equal(addMonths('2026-01-15', -3), '2025-10-15', 'across a year boundary');
});

test('the month starts on the first', () => {
  assert.equal(startOfMonth('2026-07-29'), '2026-07-01');
  assert.equal(startOfMonth('2026-01-01'), '2026-01-01');
});

test('each preset means what its label says', () => {
  const today = '2026-07-29'; // a Wednesday

  assert.deepEqual(rangeFor('today', today), { from: '2026-07-29', to: '2026-07-29' });
  assert.deepEqual(rangeFor('week', today), { from: '2026-07-23', to: '2026-07-29' });
  assert.deepEqual(rangeFor('month', today), { from: '2026-07-01', to: '2026-07-29' });
  assert.deepEqual(rangeFor('quarter', today), { from: '2026-04-29', to: '2026-07-29' });
});

test('"last week" is seven days inclusive, not eight and not six', () => {
  const { from, to } = rangeFor('week', '2026-07-29');
  let days = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) days += 1;
  assert.equal(days, 7);
});

test('custom keeps whatever dates the screen already had', () => {
  assert.equal(rangeFor('custom', '2026-07-29'), null);
  assert.equal(rangeFor('nonsense', '2026-07-29'), null);
});

test('no preset ever produces a backwards range', () => {
  // Run every preset across a year of dates, including both ends of every month.
  for (let day = 0; day < 400; day += 1) {
    const today = addDays('2025-12-01', day);
    for (const p of RANGE_PRESETS) {
      const r = rangeFor(p.key, today);
      if (!r) continue;
      assert.ok(r.from <= r.to, `${p.key} on ${today} gave ${r.from} to ${r.to}`);
      assert.match(r.from, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(r.to, /^\d{4}-\d{2}-\d{2}$/);
      // Every preset but one runs up to today. 'lastMonth' is a CLOSED calendar month by design —
      // that is the whole reason it exists next to 'month', which on the 3rd answers with 3 days —
      // so it ends before today rather than on it.
      if (p.key === 'lastMonth') {
        assert.ok(r.to < today, `${p.key} on ${today} should have closed before today`);
      } else {
        assert.equal(r.to, today, `${p.key} on ${today} should end today`);
      }
    }
  }
});

test('the arithmetic does not drift with the machine timezone', () => {
  // The whole point of parsing at noon UTC. This is the failure the app actually had: computing a
  // date in UTC while the office runs on UTC+5:30 returned yesterday before 05:30 every morning.
  const before = process.env.TZ;
  for (const tz of ['Asia/Kolkata', 'UTC', 'Pacific/Kiritimati', 'Pacific/Midway']) {
    process.env.TZ = tz;
    assert.deepEqual(rangeFor('week', '2026-07-29'), { from: '2026-07-23', to: '2026-07-29' }, tz);
    assert.equal(addMonths('2026-05-31', -3), '2026-02-28', tz);
  }
  process.env.TZ = before;
});

test('"last month" is the whole previous calendar month, not a rolling 30 days', () => {
  // Mid-month, month-end and the 1st all name the same closed month — the answer must not depend on
  // which day you happen to ask.
  for (const today of ['2026-08-06', '2026-08-01', '2026-08-31']) {
    assert.deepEqual(rangeFor('lastMonth', today), { from: '2026-07-01', to: '2026-07-31' }, today);
  }
});

test('"last month" crosses the year boundary and gets February right', () => {
  assert.deepEqual(rangeFor('lastMonth', '2026-01-15'), { from: '2025-12-01', to: '2025-12-31' });
  // 2024 is a leap year: asking in March must give 29 days, not 28.
  assert.deepEqual(rangeFor('lastMonth', '2024-03-10'), { from: '2024-02-01', to: '2024-02-29' });
  assert.deepEqual(rangeFor('lastMonth', '2026-03-10'), { from: '2026-02-01', to: '2026-02-28' });
  // From the 31st, stepping back a month must not land on a day April does not have.
  assert.deepEqual(rangeFor('lastMonth', '2026-05-31'), { from: '2026-04-01', to: '2026-04-30' });
});

test('"last month" and "this month" do not overlap or leave a gap', () => {
  // Together they should cover an unbroken stretch: last month ends the day before this one starts.
  for (const today of ['2026-08-06', '2026-01-01', '2026-03-01', '2024-03-05']) {
    const last = rangeFor('lastMonth', today);
    const thisM = rangeFor('month', today);
    assert.equal(addDays(last.to, 1), thisM.from, `contiguous on ${today}`);
  }
});
