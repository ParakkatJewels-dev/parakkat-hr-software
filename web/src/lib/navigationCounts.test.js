import { test } from 'node:test';
import assert from 'node:assert/strict';
import { navigationScreenCount, navigationSectionCount, navigationCountLabel, navigationCountTarget } from './navigationCounts.js';
import { visibleSections, predicatesFor, mobilePrimarySections } from './navMap.js';

const counts = { tasks: 127, leave: 4, expense: 7, attendance: 3, helpdesk: 2 };

test('a section sums only its permitted tabs and the phone keeps individual screen counts', () => {
  const sections = visibleSections('entity_admin', predicatesFor([], { isSuperAdmin: true }));
  const time = sections.find(section => section.id === 'time');
  assert.equal(navigationSectionCount(time, counts).count, 7);
  assert.equal(navigationCountLabel(time.label, navigationSectionCount(time, counts)), 'Time & Attendance, 7 items needing action');
  const narrowed = visibleSections('entity_admin', predicatesFor(
    ['attendance.read', 'leave.read', 'device.manage'].map(permission => ({ permission, scope_type: 'entity', scope_id: 'entity' })),
    { hiddenScreens: ['leave'] },
  ));
  assert.equal(navigationSectionCount(narrowed.find(section => section.id === 'time'), counts).count, 3);
  const mobileTime = mobilePrimarySections(sections, 'entity_admin').find(section => section.id === 'attendance');
  assert.equal(navigationSectionCount(mobileTime, counts).count, 3);
  assert.equal(navigationScreenCount('attendance-admin', counts), null, 'Shifts & Devices is not the attendance review queue');
});

test('unknown or invalid counts never become zero or an understated section total', () => {
  const section = { tabs: [{ id: 'attendance' }, { id: 'leave' }] };
  for (const invalid of [undefined, null, '3', -1, NaN, Infinity, 1.5]) {
    assert.equal(navigationScreenCount('attendance', { attendance: invalid }).count, null);
    assert.equal(navigationSectionCount(section, { attendance: 3, leave: invalid }).count, null);
  }
  assert.equal(navigationScreenCount('attendance', { attendance: 0 }).count, 0);
  assert.equal(navigationCountLabel('Time', navigationSectionCount(section, undefined)), 'Time');
});

test('screen labels distinguish pending work from unread messages and preserve the exact count', () => {
  assert.equal(navigationCountLabel('Tasks', navigationScreenCount('tasks', counts)), 'Tasks, 127 tasks to complete');
  assert.equal(navigationCountLabel('Leave', navigationScreenCount('leave', { leave: 1 })), 'Leave, 1 leave request to review');
  assert.equal(navigationCountLabel('Chat', navigationScreenCount('messages', counts, 205)), 'Chat, 205 unread messages');
  assert.equal(navigationCountLabel('Chat', navigationScreenCount('messages', counts, 0)), 'Chat');
  assert.equal(navigationSectionCount({ tabs: [{ id: 'payroll' }] }, counts), null);
});

test('positive helpdesk badges open the matching queue while other destinations retain their routes', () => {
  assert.equal(navigationCountTarget({ id: 'helpdesk' }, counts), 'helpdesk?ticketQueue=needs-action');
  for (const helpdesk of [0, undefined, null, -1]) assert.equal(navigationCountTarget({ id: 'helpdesk' }, { helpdesk }), 'helpdesk');
  assert.equal(navigationCountTarget({ id: 'tasks', to: 'tasks/routine' }, counts), 'tasks/routine');
});
