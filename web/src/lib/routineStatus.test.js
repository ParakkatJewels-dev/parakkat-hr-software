import { test } from 'node:test';
import assert from 'node:assert/strict';
import { employeeRoutineStatus } from './routineStatus.js';

test('employee status combines all routines before declaring completion and puts unfinished people first', () => {
  const rows = [
    { employee_id: 'ann', employee: { full_name: 'Ann' }, scheduled: '2', completed: '2' },
    { employee_id: 'ann', employee: { full_name: 'Ann' }, scheduled: '3', completed: '0' },
    { employee_id: 'ben', scheduled: 2, completed: 2 },
    { employee_id: 'cal', scheduled: 1, completed: 0 },
    { employee_id: 'unscheduled', scheduled: 0, completed: 0, unscored_done_jobs: 8 },
  ];
  assert.deepEqual(employeeRoutineStatus(rows).map(({ employeeId, scheduled, completed, pending, status, pct }) =>
    ({ employeeId, scheduled, completed, pending, status, pct })), [
    { employeeId: 'cal', scheduled: 1, completed: 0, pending: 1, status: 'Not started', pct: 0 },
    { employeeId: 'ann', scheduled: 5, completed: 2, pending: 3, status: 'In progress', pct: 40 },
    { employeeId: 'ben', scheduled: 2, completed: 2, pending: 0, status: 'Completed', pct: 100 },
  ]);
});

test('no due work never creates a completed employee', () => {
  assert.deepEqual(employeeRoutineStatus(null), []);
  assert.deepEqual(employeeRoutineStatus([{ employee_id: 'ann', scheduled: 0, completed: 0 }]), []);
});
