// The recompute range: ordered, and never reaching past today.
//
//   npx tsx --test src/engine/range.test.ts
//
// Every case here is one that has actually produced wrong data in this system. A range that
// reaches into the future invents absences; a backwards range makes the loaders return nothing
// and turns a normal working day into a company-wide absence. Both are silent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRecomputeRange } from './windows';

const TODAY = '2026-07-29';

test('an ordinary past range is returned unchanged', () => {
  assert.deepEqual(resolveRecomputeRange('2026-07-01', '2026-07-28', TODAY), {
    from: '2026-07-01', to: '2026-07-28',
  });
});

test('a range ending in the future is cut off at today', () => {
  // `--month 2026-07` on the 29th. The 30th and 31st have not happened.
  assert.deepEqual(resolveRecomputeRange('2026-07-01', '2026-07-31', TODAY), {
    from: '2026-07-01', to: TODAY,
  });
});

test('today itself is included, not trimmed off by an off-by-one', () => {
  const r = resolveRecomputeRange('2026-07-29', '2026-07-29', TODAY);
  assert.deepEqual(r, { from: TODAY, to: TODAY });
});

test('a range entirely in the future is refused, not silently reversed', () => {
  // The expensive one. Clamping `to` to today while `from` stays in September leaves from > to;
  // eachWorkDate swaps it but the loaders do not, so they find no punches and every employee is
  // marked absent for a day they actually worked.
  assert.throws(
    () => resolveRecomputeRange('2026-09-01', '2026-09-30', TODAY),
    /entirely in the future/
  );
});

test('a backwards range is put in order rather than left to the loaders', () => {
  assert.deepEqual(resolveRecomputeRange('2026-07-28', '2026-07-20', TODAY), {
    from: '2026-07-20', to: '2026-07-28',
  });
});

test('a backwards range that also runs past today is both ordered and clamped', () => {
  assert.deepEqual(resolveRecomputeRange('2026-08-15', '2026-07-01', TODAY), {
    from: '2026-07-01', to: TODAY,
  });
});

test('whatever comes back is never backwards and never in the future', () => {
  const dates = ['2026-06-01', '2026-07-01', '2026-07-29', '2026-07-31', '2026-12-25'];
  for (const a of dates) {
    for (const b of dates) {
      let r;
      try {
        r = resolveRecomputeRange(a, b, TODAY);
      } catch {
        // Only legitimate when both ends are past today.
        assert.ok(a > TODAY && b > TODAY, `refused ${a}..${b}, which is not wholly in the future`);
        continue;
      }
      assert.ok(r.from <= r.to, `${a}..${b} gave ${r.from}..${r.to}`);
      assert.ok(r.to <= TODAY, `${a}..${b} reaches past today`);
    }
  }
});
