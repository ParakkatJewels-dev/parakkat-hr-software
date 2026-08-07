// Which link in the punch chain is broken.
//
//   npm test
//
// The case that matters most is the one that actually happened: hops 2 and 3 perfectly healthy
// while hop 1 was dead, which every indicator reported as green for five hours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, withinWorkingHours, forHumans, DIAGNOSIS } from './syncDiagnosis.js';

// 29 July 2026 was a Wednesday. 12:00 IST = 06:30 UTC.
const NOON = Date.UTC(2026, 6, 29, 6, 30);
const ago = (mins) => new Date(NOON - mins * 60_000).toISOString();

const at = (o) => diagnose({ nowMs: NOON, ...o });

test('all three links healthy reads as working', () => {
  const d = at({ newestRunAt: ago(1), lastSuccessAt: ago(1), lastPunchAt: ago(4) });
  assert.equal(d.level, 'ok');
  assert.equal(d.brokenHop, null);
});

test('the machine stopping is named, while the other two are reported healthy', () => {
  // 29 July, exactly. The service polled every 2 minutes and every poll succeeded against Easy
  // Time Pro; the terminal had not uploaded since 13:07. This is the case that read green.
  const d = at({ newestRunAt: ago(1), lastSuccessAt: ago(1), lastPunchAt: ago(301) });
  assert.equal(d.level, 'terminal-down');
  assert.equal(d.brokenHop, 1);
  // The one-liner names the fault; the repair procedure it used to be bundled with is in `fix`.
  assert.match(DIAGNOSIS[d.level].hint, /terminal has not handed over a punch/);
  assert.match(DIAGNOSIS[d.level].fix, /Easy Time Pro and the sync service are both fine/);
});

test('runs still arriving but never succeeding points at Easy Time Pro, not the machine', () => {
  // The service is alive — it is writing runs — so the thing it cannot reach is Easy Time Pro.
  const d = at({ newestRunAt: ago(1), lastSuccessAt: ago(40), lastPunchAt: ago(45) });
  assert.equal(d.level, 'biotime-unreachable');
  assert.equal(d.brokenHop, 2);
});

test('no runs at all is the service, and it must not claim to know about the rest', () => {
  // Punches look recent here, and that is exactly the trap: those numbers are frozen at whatever
  // was last written. Reporting "machine fine" off stale data would be a lie.
  const d = at({ newestRunAt: ago(90), lastSuccessAt: ago(90), lastPunchAt: ago(2) });
  assert.equal(d.level, 'service-down');
  assert.equal(d.brokenHop, 3);
  assert.match(DIAGNOSIS[d.level].hint, /two links behind it cannot be checked/);
  assert.match(DIAGNOSIS[d.level].fix, /nothing can be said about the machine/);
});

test('everything down at once reports the outermost link, not the innermost', () => {
  const d = at({ newestRunAt: ago(600), lastSuccessAt: ago(600), lastPunchAt: ago(600) });
  assert.equal(d.level, 'service-down');
  assert.equal(d.brokenHop, 3, 'the one that must be fixed first');
});

test('never heard from at all is handled, not crashed on', () => {
  const d = at({ newestRunAt: null, lastSuccessAt: null, lastPunchAt: null });
  assert.equal(d.level, 'service-down');
  assert.equal(forHumans(d.minutes), 'ever');
});

test('a normal lull is not an alarm', () => {
  // The longest legitimate silence ever recorded here is 74 minutes.
  const d = at({ newestRunAt: ago(1), lastSuccessAt: ago(1), lastPunchAt: ago(74) });
  assert.equal(d.level, 'quiet');
  assert.equal(d.brokenHop, null, 'nothing is broken, so nothing is blamed');
});

test('silence at night and on Sunday raises nothing', () => {
  const tenPm = Date.UTC(2026, 6, 29, 16, 30); // 22:00 IST Wednesday
  const sunday = Date.UTC(2026, 6, 26, 6, 30); // 12:00 IST Sunday
  for (const nowMs of [tenPm, sunday]) {
    const d = diagnose({
      nowMs,
      newestRunAt: new Date(nowMs - 60_000).toISOString(),
      lastSuccessAt: new Date(nowMs - 60_000).toISOString(),
      lastPunchAt: new Date(nowMs - 600 * 60_000).toISOString(),
    });
    assert.equal(d.level, 'off-hours');
  }
});

test('working hours are Monday to Saturday, 08:00 to 20:00 IST', () => {
  assert.equal(withinWorkingHours(Date.UTC(2026, 6, 29, 2, 30)), true, '08:00 Wed');
  assert.equal(withinWorkingHours(Date.UTC(2026, 6, 29, 14, 29)), true, '19:59 Wed');
  assert.equal(withinWorkingHours(Date.UTC(2026, 6, 29, 14, 30)), false, '20:00 Wed');
  assert.equal(withinWorkingHours(Date.UTC(2026, 6, 29, 2, 29)), false, '07:59 Wed');
  assert.equal(withinWorkingHours(Date.UTC(2026, 6, 25, 6, 30)), true, 'Saturday is a working day');
  assert.equal(withinWorkingHours(Date.UTC(2026, 6, 26, 6, 30)), false, 'Sunday is not');
});

test('every level has a label, a tone and a chain diagram', () => {
  for (const [key, d] of Object.entries(DIAGNOSIS)) {
    assert.ok(d.label && d.tone && d.chain && d.hint, key);
  }
});

test('every broken state says what to do; the healthy ones do not need to', () => {
  // A red status nobody can act on is decoration. "Working" needs no instructions.
  for (const key of ['terminal-down', 'biotime-unreachable', 'service-down']) {
    assert.match(DIAGNOSIS[key].fix, /Check|Run|reboot|services\.msc/, `${key} names no action`);
    assert.ok(DIAGNOSIS[key].fix.length > 120, `${key} is too terse to act on`);
  }
  for (const key of ['ok', 'quiet', 'off-hours']) {
    assert.equal(DIAGNOSIS[key].fix, null, `${key} should not offer a repair`);
    assert.doesNotMatch(DIAGNOSIS[key].hint, /reboot|services\.msc/, `${key} should not alarm`);
  }
});

// The reason the split exists. This line is the whole of the status on a phone, and four lines of
// prose there is a wall people learn to scroll past — which is how a status stops being read.
test('the always-on line stays one line, and leads with the fault', () => {
  for (const [key, d] of Object.entries(DIAGNOSIS)) {
    assert.ok(d.hint.length <= 120, `${key} hint is ${d.hint.length} chars — too long to sit above the fold`);
    assert.doesNotMatch(d.hint, /services\.msc|reboot/, `${key} hint carries repair steps that belong in fix`);
  }
});

test('durations read the way somebody would say them', () => {
  assert.equal(forHumans(4), '4m');
  assert.equal(forHumans(59), '59m');
  assert.equal(forHumans(60), '1h 0m');
  assert.equal(forHumans(301), '5h 1m');
});
