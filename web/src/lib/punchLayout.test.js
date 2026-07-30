// Packing punch labels under the timeline bar.
//
//   npm test
//
// Worth testing because the failure is silent and only visible at certain widths: two labels land
// on the same spot and one is unreadable, or a label at the very end hangs off the container.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelLayout, rowCount } from './punchLayout.js';

const at = (hhmm) => `2026-07-29T${hhmm}:00+05:30`;

/** Kasinath, 29 July — 8 punches over 9h 14m, with 13:42 and 13:48 six minutes apart. */
const REAL = ['09:37', '13:23', '13:42', '13:48', '14:14', '15:47', '16:21', '18:51'].map(at);

test('the first and last punches sit at the ends of the bar', () => {
  const l = labelLayout(REAL);
  assert.equal(l[0].pct, 0);
  assert.equal(l[l.length - 1].pct, 100);
});

test('a punch lands at its true position along the day', () => {
  // 09:37 to 18:51 is 554 minutes; 14:14 is 277 in, exactly halfway.
  const l = labelLayout(REAL);
  const noon = l.find((x) => x.punch === at('14:14'));
  assert.equal(Math.round(noon.pct), 50);
});

test('labels too close together drop to another row instead of overlapping', () => {
  const l = labelLayout(REAL);
  const a = l.find((x) => x.punch === at('13:42'));
  const b = l.find((x) => x.punch === at('13:48'));
  // Six minutes apart on a nine-hour bar — about 1% of the width.
  assert.ok(Math.abs(a.pct - b.pct) < 2, 'they really are on top of each other');
  assert.notEqual(a.row, b.row, 'so they must not share a row');
});

test('no two labels on the same row are closer than the gap', () => {
  // The property that matters, asserted directly rather than trusting the loop.
  const l = labelLayout(REAL, 7);
  for (const row of new Set(l.map((x) => x.row))) {
    const onRow = l.filter((x) => x.row === row).sort((x, y) => x.pct - y.pct);
    for (let i = 1; i < onRow.length; i += 1) {
      assert.ok(onRow[i].pct - onRow[i - 1].pct >= 7,
        `row ${row}: ${onRow[i - 1].pct} and ${onRow[i].pct} are too close`);
    }
  }
});

test('well-spaced punches all stay on one row', () => {
  const l = labelLayout(['09:00', '13:00', '13:40', '18:00'].map(at));
  assert.equal(rowCount(l), 1, 'the ordinary day needs no stacking');
});

test('the ends anchor rather than centre, so nothing hangs off the container', () => {
  const l = labelLayout(REAL);
  assert.equal(l[0].align, 'start');
  assert.equal(l[l.length - 1].align, 'end');
  assert.equal(l.find((x) => x.punch === at('14:14')).align, 'middle');
});

test('a short day is not crowded — the bar scales to its own span', () => {
  // Five punches inside eight minutes. Crowded on a clock, but the bar covers only those eight
  // minutes, so they land 25% apart and share a row comfortably. Worth pinning: it is the reason
  // stacking is rare in practice, and the reason the gap is measured in percent and not minutes.
  const l = labelLayout(['09:00', '09:02', '09:04', '09:06', '09:08'].map(at));
  assert.equal(rowCount(l), 1);
  assert.deepEqual(l.map((x) => Math.round(x.pct)), [0, 25, 50, 75, 100]);
});

test('crowding is relative to the span, so a long day is what stacks', () => {
  // The same eight minutes inside a nine-hour day: now they are 1.4% apart and must stack.
  const l = labelLayout(['09:00', '09:02', '09:04', '09:06', '09:08', '18:00'].map(at));
  assert.ok(rowCount(l) > 1, 'the early cluster cannot fit on one row');
  const cluster = l.slice(0, 5);
  assert.equal(new Set(cluster.map((x) => x.row)).size, 5, 'each needs its own row');
});

test('two punches at the same instant do not loop forever', () => {
  const l = labelLayout([at('09:00'), at('09:00')]);
  assert.equal(l.length, 2);
  assert.notEqual(l[0].row, l[1].row);
});

test('a single punch has no span and sits at the start', () => {
  const l = labelLayout([at('09:37')]);
  assert.equal(l[0].pct, 0);
  assert.equal(rowCount(l), 1);
});

test('nothing in, nothing out', () => {
  assert.deepEqual(labelLayout([]), []);
  assert.deepEqual(labelLayout(null), []);
  assert.equal(rowCount([]), 0);
});

// ---------------------------------------------------------------------------
// how long each stretch lasted, over the stretch itself
// ---------------------------------------------------------------------------

import { spanLabels, shortDuration } from './punchLayout.js';

/** Kasinath's 29 July, paired the way the engine pairs it. */
const SEGS = [
  { from: at('09:37'), to: at('13:23'), minutes: 226, away: false, unknown: false },
  { from: at('13:23'), to: at('13:42'), minutes: 19,  away: true,  unknown: false },
  { from: at('13:42'), to: at('13:48'), minutes: 6,   away: false, unknown: false },
  { from: at('13:48'), to: at('14:14'), minutes: 26,  away: true,  unknown: false },
  { from: at('14:14'), to: at('15:47'), minutes: 93,  away: false, unknown: false },
  { from: at('15:47'), to: at('16:21'), minutes: 34,  away: true,  unknown: false },
  { from: at('16:21'), to: at('18:51'), minutes: 150, away: false, unknown: false },
];

test('durations read the way somebody says them out loud', () => {
  assert.equal(shortDuration(19), '19m');
  assert.equal(shortDuration(59), '59m');
  assert.equal(shortDuration(60), '1h');
  assert.equal(shortDuration(93), '1h 33m');
  assert.equal(shortDuration(150), '2h 30m');
  assert.equal(shortDuration(0), '0m');
});

test('each stretch is labelled over its own middle', () => {
  const l = spanLabels(SEGS, REAL);
  const firstStretch = l[0];
  assert.equal(firstStretch.text, '3h 46m');
  // 09:37 to 13:23 is the first 40.8% of the bar, so its midpoint is near 20%.
  assert.ok(Math.abs(firstStretch.pct - 20.4) < 1);
});

test('a stretch too narrow for its text is moved, never dropped', () => {
  const l = spanLabels(SEGS, REAL);
  // 13:42 to 13:48 is six minutes on a nine-hour bar: about 1% of the width.
  const tiny = l.find((s) => s.minutes === 6);
  assert.ok(tiny.widthPct < 2);
  assert.equal(tiny.inline, false, 'it cannot sit inside its own stretch');
  assert.ok(tiny.row >= 0, 'but it still has a place — the break length is why the day was opened');

  const long = l.find((s) => s.minutes === 150);
  assert.equal(long.inline, true, 'the long afternoon has room to spare');
});

test('every break is labelled, which is the number people came for', () => {
  const l = spanLabels(SEGS, REAL).filter((s) => s.away);
  assert.deepEqual(l.map((s) => s.text), ['19m', '26m', '34m'], 'all three, none hidden');
});

test('no two duration labels on a row overlap', () => {
  const l = spanLabels(SEGS, REAL);
  for (const row of new Set(l.map((x) => x.row))) {
    const onRow = l.filter((x) => x.row === row).sort((a, b) => a.pct - b.pct);
    for (let i = 1; i < onRow.length; i += 1) {
      const gap = onRow[i].pct - onRow[i - 1].pct;
      const needed = (onRow[i].needs + onRow[i - 1].needs) / 2;
      assert.ok(gap >= needed,
        `row ${row}: "${onRow[i - 1].text}" and "${onRow[i].text}" are ${gap.toFixed(1)}% apart, need ${needed.toFixed(1)}%`);
    }
  }
});

test('an unaccounted stretch is marked, not measured', () => {
  const l = spanLabels(
    [{ from: at('09:00'), to: at('18:00'), minutes: 540, away: false, unknown: true }],
    [at('09:00'), at('18:00')]
  );
  assert.equal(l[0].text, '?');
});

test('nothing to label when there is no span', () => {
  assert.deepEqual(spanLabels([], REAL), []);
  assert.deepEqual(spanLabels(SEGS, [at('09:00')]), []);
  assert.deepEqual(spanLabels(SEGS, [at('09:00'), at('09:00')]), [], 'a zero-length day');
});
