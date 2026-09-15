import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardActions } from './dashboardActions.js';

const today = '2026-09-15';
const task = (id, values = {}) => ({ id, employee_id: 'me', title: id, status: 'To Do', ...values });
const assignment = (ref_id, id = ref_id) => ({ id, type: 'task', title: 'New task assigned', ref_id, read_at: null });
const actions = (values) => dashboardActions({ today, employeeId: 'me', ...values });

test('Home message counts follow live unread messages, including requests, and disappear after reading', () => {
  const result = actions({ conversations: [{ id: 'a', unread_count: 3 }, { id: 'b', unread_count: 2, request_status: 'pending' },
    { id: 'c', unread_count: 100, request_status: 'declined' }] });
  assert.equal(result[0].title, 'You have 5 unread messages');
  assert.equal(result[0].target, 'messages');
  assert.deepEqual(actions({ conversations: [{ id: 'a', unread_count: 0 }] }), []);
  const [single] = actions({ conversations: [{ id: 'a', unread_count: 1 }] });
  assert.equal(single.title, 'You have 1 unread message');
  assert.equal(single.target, 'messages?focus=a');
});

test('overdue and due today take priority over assignment notices, with each task counted once', () => {
  const result = actions({ tasks: [task('late', { due_date: '2026-09-14' }), task('today', { due_date: today }), task('new')],
    assignments: ['late', 'today', 'new'].map((id) => assignment(id)) });
  assert.deepEqual(result.map((r) => [r.id, r.count]), [['tasks-overdue', 1], ['tasks-due', 1], ['tasks-new', 1]]);
  assert.equal(result[2].title, 'You have a new task');
});

test('a new task requires an unread assignment notice and current ownership; duplicate notices count once', () => {
  const result = actions({ tasks: [task('new'), task('read'), task('updated'), task('own'), task('other', { employee_id: 'other' })],
    assignments: [assignment('new'), assignment('new', 'second'), { ...assignment('read'), read_at: 'read' },
      { ...assignment('updated'), title: 'Task updated' }, assignment('other'), assignment('gone')] });
  assert.deepEqual(result.map((r) => [r.id, r.count]), [['tasks-new', 1], ['tasks-todo', 3]]);
});

test('closed tasks vanish and secondary assignees get their own live tasks', () => {
  const result = actions({ tasks: [task('done', { status: 'Done', due_date: '2020-01-01' }), task('cancelled', { status: 'Cancelled' }),
    task('shared', { employee_id: 'other', assignees: [{ employee_id: 'other' }, { employee_id: 'me' }], due_date: today }),
    task('blocked', { status: 'Blocked' }), task('active', { status: 'In Progress' })] });
  assert.deepEqual(result.map((r) => r.id), ['tasks-due', 'tasks-blocked', 'tasks-active']);
  assert.equal(result[0].target, 'tasks/todo?focus=shared');
});

test('task deadlines roll over using the supplied IST date', () => {
  const values = { employeeId: 'me', tasks: [task('midnight', { due_date: today })] };
  assert.equal(dashboardActions({ ...values, today })[0].id, 'tasks-due');
  assert.equal(dashboardActions({ ...values, today: '2026-09-16' })[0].id, 'tasks-overdue');
});

test('approval and support cards name exact work and target one row when possible', () => {
  const result = actions({ approvals: { leaves: [{ id: 'leave' }], expenses: [{ id: 'e1' }, { id: 'e2' }], punches: [{ id: 'p' }] },
    helpRequests: [{ id: 'help' }], tickets: [{ id: 'ticket' }] });
  assert.deepEqual(result.map((r) => r.target), ['leave?focus=leave', 'expense', 'attendance/regularizations?focus=p',
    'tasks/requests?focus=help', 'helpdesk?focus=ticket']);
  assert.equal(result[1].title, '2 expense claims awaiting your approval');
});

test('Home does not cap growing unread counts or assigned tasks', () => {
  const result = actions({ conversations: Array.from({ length: 125 }, (_, i) => ({ id: `c${i}`, unread_count: 10 })),
    tasks: Array.from({ length: 1205 }, (_, i) => task(`task${i}`, { due_date: today })) });
  assert.equal(result[0].count, 1250);
  assert.equal(result[1].count, 1205);
});

test('missing employee linkage never counts other peoples tasks', () => {
  assert.deepEqual(dashboardActions({ today, tasks: [task('someone')] }), []);
});
