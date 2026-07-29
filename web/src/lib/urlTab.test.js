// Reading a screen and tab out of a URL path.
//
//   npm test
//
// The whole point of this module is that a refresh puts you back where you were, so the cases that
// matter are the ones where a path is malformed, stale, or names something the page does not have.
// Each of those used to end at the dashboard or at an empty tab bar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenFromPath, tabFromPath, pathForTab } from './urlTab.js';

const ATTENDANCE = ['today', 'calendar', 'exceptions', 'regularizations'];

test('the screen is the first segment and nothing else', () => {
  assert.equal(screenFromPath('/attendance'), 'attendance');
  assert.equal(screenFromPath('/attendance/exceptions'), 'attendance');
  assert.equal(screenFromPath('/attendance-admin/sync'), 'attendance-admin');
  assert.equal(screenFromPath('/'), '');
  assert.equal(screenFromPath(''), '');
});

test('a refresh on a tab comes back to that tab', () => {
  // The actual complaint: this used to return the default every time.
  assert.equal(tabFromPath('/attendance/exceptions', 'today', ATTENDANCE), 'exceptions');
  assert.equal(tabFromPath('/attendance/regularizations', 'today', ATTENDANCE), 'regularizations');
});

test('a screen with no tab in the path opens its default tab', () => {
  assert.equal(tabFromPath('/attendance', 'today', ATTENDANCE), 'today');
  assert.equal(tabFromPath('/', 'today', ATTENDANCE), 'today');
});

test('a tab this page does not have falls back instead of rendering nothing', () => {
  // A stale bookmark, a renamed tab, or a tab filtered out because the user lacks its permission.
  // Selecting it would leave the bar with nothing highlighted and no content underneath.
  assert.equal(tabFromPath('/attendance/payslips', 'today', ATTENDANCE), 'today');
  assert.equal(tabFromPath('/attendance/../etc', 'today', ATTENDANCE), 'today');
});

test('with no list of valid tabs, whatever the URL says is taken at face value', () => {
  assert.equal(tabFromPath('/payroll/runs', 'payslips', undefined), 'runs');
});

test('trailing and doubled slashes do not change the answer', () => {
  assert.equal(tabFromPath('/attendance/exceptions/', 'today', ATTENDANCE), 'exceptions');
  assert.equal(tabFromPath('//attendance//exceptions', 'today', ATTENDANCE), 'exceptions');
  assert.equal(screenFromPath('/attendance/'), 'attendance');
});

test('selecting a tab keeps the screen it belongs to', () => {
  assert.equal(pathForTab('/attendance/today', 'exceptions'), '/attendance/exceptions');
  assert.equal(pathForTab('/attendance', 'calendar'), '/attendance/calendar');
  assert.equal(pathForTab('/attendance-admin/mapping', 'sync'), '/attendance-admin/sync');
});

test('a path round-trips: select a tab, read it back, get the same tab', () => {
  for (const tab of ATTENDANCE) {
    const path = pathForTab('/attendance/today', tab);
    assert.equal(tabFromPath(path, 'today', ATTENDANCE), tab, path);
    assert.equal(screenFromPath(path), 'attendance');
  }
});

test('deeper paths are ignored rather than confusing the tab', () => {
  // Nothing writes these today, but a hand-edited or truncated URL must not select a mystery tab.
  assert.equal(tabFromPath('/attendance/exceptions/extra/bits', 'today', ATTENDANCE), 'exceptions');
});
