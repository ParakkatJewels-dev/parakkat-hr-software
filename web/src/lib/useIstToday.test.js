import test from 'node:test';
import assert from 'node:assert/strict';
import { untilNextIstDay, watchIstDay } from './useIstToday.js';

test('the daily reset occurs at midnight IST, including month and year boundaries', () => {
  for (const instant of ['2026-09-11T18:29:59.990Z', '2026-12-31T18:29:59.990Z', '2028-02-29T18:29:59.990Z']) {
    assert.equal(untilNextIstDay(Date.parse(instant)), 35);
  }
  assert.equal(untilNextIstDay(Date.parse('2026-09-11T18:30:00Z')), 86_400_025);
});

test('an open Home refreshes at midnight and a sleeping tab refreshes on wake, then removes listeners', () => {
  let instant = Date.parse('2026-09-11T18:29:59Z');
  let timer, wake, updates = 0, removed = false, delay;
  const cancelled = [];
  const stop = watchIstDay(() => updates++, {
    now: () => instant,
    schedule(fn, ms) { timer = fn; delay = ms; return 7; },
    cancel(id) { cancelled.push(id); },
    onWake(fn) { wake = fn; return () => { removed = true; }; },
  });
  assert.equal(delay, 1025);
  instant = Date.parse('2026-09-11T18:30:00.025Z');
  timer();
  assert.equal(updates, 1);
  wake();
  assert.equal(updates, 1, 'focusing on the same day does not create a false reset');
  instant = Date.parse('2026-09-14T04:00:00Z');
  wake();
  assert.equal(updates, 2, 'a suspended tab catches up to the actual current work date');
  stop();
  assert.equal(removed, true);
  assert.equal(cancelled.at(-1), 7);
});
