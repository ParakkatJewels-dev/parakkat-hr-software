import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NAVIGATION_COUNT_KEYS, navigationScreenCount, navigationSectionCount, navigationCountLabel, navigationCountTarget } from './navigationCounts.js';
import { visibleSections, predicatesFor, mobilePrimarySections } from './navMap.js';

const counts = { ...Object.fromEntries(NAVIGATION_COUNT_KEYS.map(key => [key, 0])),
  tasks: 127, leave: 4, expense: 7, attendance: 3, helpdesk: 2 };

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
  assert.equal(navigationScreenCount('attendance-admin', counts).count, 0, 'Shifts & Devices counts mapping work separately');
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
  assert.equal(navigationSectionCount({ tabs: [{ id: 'payroll' }] }, counts).count, 0);
});

test('positive helpdesk badges open the matching queue while other destinations retain their routes', () => {
  assert.equal(navigationCountTarget({ id: 'helpdesk' }, counts), 'helpdesk?ticketQueue=needs-action');
  for (const helpdesk of [0, undefined, null, -1]) assert.equal(navigationCountTarget({ id: 'helpdesk' }, { helpdesk }), 'helpdesk');
  assert.equal(navigationCountTarget({ id: 'tasks', to: 'tasks/routine' }, counts), 'tasks/routine');
});

const complete = { tasks: 2, task_requests: 3, task_routine: 4, performance_mine: 5, performance_team: 6,
  payroll: 7, onboarding: 8, recruitment: 9, exits: 10, notifications: 11, attendance_mapping: 12,
  leave: 13, expense: 14, attendance: 15, helpdesk: 16 };

test('every actionable parent is the sum of its distinct destination queues', () => {
  assert.deepEqual(new Set(Object.keys(complete)), new Set(NAVIGATION_COUNT_KEYS));
  const sections = visibleSections('entity_admin', predicatesFor([], { isSuperAdmin: true }));
  for (const [id, expected] of Object.entries({ work: 20, time: 40, pay: 21, people: 17, support: 26, account: 11 })) {
    assert.equal(navigationSectionCount(sections.find(section => section.id === id), complete).count, expected, id);
  }
  for (const [id, expected] of Object.entries({
    'tasks/todo': 2, 'tasks/requests': 3, 'tasks/routine': 4,
    'performance/mine': 5, 'performance/team': 6, 'payroll/run': 7,
    'helpdesk/exits': 10, 'attendance-admin/mapping': 12, 'attendance/regularizations': 15, 'helpdesk/tickets': 16,
  })) assert.equal(navigationScreenCount(id, complete).count, expected, id);
  for (const id of ['reports', 'directory', 'organization', 'assets', 'documents', 'settings', 'administration', 'payroll/salary']) {
    assert.equal(navigationScreenCount(id, complete), null, `${id} has no actionable queue`);
  }
});

test('unknown child queues cannot masquerade as a complete parent total and hidden queues are excluded', () => {
  for (const key of ['tasks', 'task_requests', 'task_routine']) {
    assert.equal(navigationScreenCount('tasks', { ...complete, [key]: null }).count, null);
    const partial = { ...complete }; delete partial[key];
    assert.equal(navigationScreenCount('tasks', partial).count, null);
  }
  const sections = visibleSections('entity_admin', predicatesFor(
    ['task.read', 'goal.read', 'payslip.read', 'expense.read'].map(permission => ({ permission, scope_type: 'entity', scope_id: 'entity' })),
    { hiddenScreens: ['performance', 'expense'] },
  ));
  assert.equal(navigationSectionCount(sections.find(section => section.id === 'work'), complete).count, 9);
  assert.equal(navigationSectionCount(sections.find(section => section.id === 'pay'), complete).count, 7);
});
