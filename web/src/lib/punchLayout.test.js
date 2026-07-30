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
