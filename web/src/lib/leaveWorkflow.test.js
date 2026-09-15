import test from 'node:test';
import assert from 'node:assert/strict';
import { canReviewLeave, leaveDecisionsFor, leaveStageLabel, matchesLeaveFilter, leaveDecisionLabel } from './leaveWorkflow.js';

const waiting = { employee_id: 'employee', status: 'Pending', approval_stage: 'department', can_decide: true };
test('department approval means forwarding; only the HR stage offers sanction', () => {
  assert.equal(leaveDecisionsFor(waiting, 'head')[0].label, 'Approve & forward to HR');
  assert.equal(leaveDecisionsFor({ ...waiting, approval_stage: 'hr' }, 'hr')[0].label, 'Sanction leave');
  assert.equal(leaveStageLabel(waiting), 'Awaiting Department head review');
  assert.equal(leaveStageLabel({ ...waiting, approval_stage: 'hr' }), 'Awaiting HR sanction');
});
test('review controls require current server permission and exclude self or Employee view', () => {
  assert.equal(canReviewLeave(waiting, 'head'), true);
  assert.equal(canReviewLeave(waiting, 'employee'), false);
  assert.equal(canReviewLeave(waiting, 'head', true), false);
  assert.equal(canReviewLeave({ ...waiting, can_decide: false }, 'head'), false);
  assert.equal(canReviewLeave({ ...waiting, can_decide: undefined }, 'head'), false);
  assert.equal(canReviewLeave({ ...waiting, status: 'Approved' }, 'head'), false);
});
test('a missing department head follows the effective HR fallback, including filters', () => {
  const row = { ...waiting, effective_stage: 'hr' };
  assert.equal(leaveStageLabel(row), 'Awaiting HR sanction');
  assert.equal(leaveDecisionsFor(row, 'hr')[0].label, 'Sanction leave');
  assert.equal(matchesLeaveFilter(row, 'HR sanction'), true);
  assert.equal(matchesLeaveFilter(row, 'Department review'), false);
});
test('holding a request keeps its stage and resumes review without sanctioning it', () => {
  const held = { ...waiting, status: 'On Hold' };
  assert.equal(canReviewLeave(held, 'head'), true);
  assert.deepEqual(leaveDecisionsFor(held, 'head').map((item) => item.value), ['Approved', 'Rejected', 'Pending']);
  assert.equal(leaveStageLabel(held), 'On hold · Department head review');
});
test('closed leave is editable only with explicit reopen authority', () => {
  const closed = { ...waiting, status: 'Approved', approval_stage: 'completed', can_decide: false };
  assert.deepEqual(leaveDecisionsFor(closed, 'head'), []);
  assert.deepEqual(leaveDecisionsFor({ ...closed, can_reopen: true }, 'hr').map((item) => item.value), ['Pending', 'Cancelled']);
  assert.deepEqual(leaveDecisionsFor({ ...closed, can_reopen: true }, 'employee'), []);
});
test('review queue filters never include another stage or finished work', () => {
  assert.equal(matchesLeaveFilter(waiting, 'My review queue', 'head'), true);
  assert.equal(matchesLeaveFilter({ ...waiting, can_decide: false }, 'My review queue', 'head'), false);
  assert.equal(matchesLeaveFilter({ ...waiting, status: 'Approved' }, 'Department review', 'head'), false);
});
test('decision history explicitly distinguishes department approval from HR sanction', () => {
  assert.equal(leaveDecisionLabel({ stage: 'department', decision: 'Approved' }), 'Department approved · forwarded to HR');
  assert.equal(leaveDecisionLabel({ stage: 'hr', decision: 'Approved' }), 'HR sanctioned leave');
  assert.equal(leaveDecisionLabel({ stage: 'department', decision: 'Rejected' }), 'Department head rejected leave');
});
