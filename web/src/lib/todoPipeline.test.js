import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PIPELINE, stageIndex, nextStage, advanceLabel, myBoard, sortForMe, progress, isSelfSet,
} from './todoPipeline.js';

const ME = 'me';
const TODAY = '2026-09-20';
const t = (over = {}) => ({
  id: over.title ?? 'x', employee_id: ME, assigned_by: ME,
  status: 'To Do', priority: 'Medium', due_date: null, ...over,
});

test('Cancelled is not a stage on the way to anywhere', () => {
  assert.deepEqual(PIPELINE, ['To Do', 'In Progress', 'Blocked', 'Done']);
  assert.equal(stageIndex('Cancelled'), -1);
  assert.equal(nextStage('Cancelled'), null);
  assert.equal(advanceLabel('Cancelled'), null);
});

test('Blocked goes back to In Progress, not forward to Done', () => {
  // Being blocked is a state you leave by getting unblocked.
  assert.equal(nextStage('Blocked'), 'In Progress');
  assert.equal(advanceLabel('Blocked'), 'Unblock');
  assert.equal(nextStage('To Do'), 'In Progress');
  assert.equal(nextStage('In Progress'), 'Done');
  assert.equal(nextStage('Done'), null, 'finished work does not advance');
});

test('my board is what is ASSIGNED to me, whoever put it there', () => {
  const rows = [
    t({ title: 'mine-self' }),
    t({ title: 'from-head', assigned_by: 'boss' }),
    t({ title: 'someone-else', employee_id: 'other' }),
  ];
  const board = myBoard(rows, ME, { today: TODAY });
  assert.deepEqual(board.open.map((r) => r.title).sort(), ['from-head', 'mine-self']);
  assert.ok(!board.all.some((r) => r.title === 'someone-else'));
});

test('done and cancelled leave the open list', () => {
  const board = myBoard([
    t({ title: 'a' }), t({ title: 'b', status: 'Done' }), t({ title: 'c', status: 'Cancelled' }),
  ], ME, { today: TODAY });
  assert.deepEqual(board.open.map((r) => r.title), ['a']);
  assert.deepEqual(board.closed.map((r) => r.title).sort(), ['b', 'c']);
});

test('overdue leads, then due date, then priority', () => {
  const rows = sortForMe([
    t({ title: 'later', due_date: '2026-12-01' }),
    t({ title: 'overdue', due_date: '2026-09-01' }),
    t({ title: 'urgent-no-date', priority: 'Urgent' }),
    t({ title: 'soon', due_date: '2026-09-25' }),
  ], TODAY);
  assert.equal(rows[0].title, 'overdue');
  assert.equal(rows[1].title, 'soon');
  assert.equal(rows[2].title, 'later');
  assert.equal(rows[3].title, 'urgent-no-date', 'no due date sorts last, then by priority');
});

test('progress counts Done against everything that is not Cancelled', () => {
  const p = progress([
    t({ status: 'Done' }), t({ status: 'Done' }),
    t({ status: 'To Do' }), t({ status: 'Blocked' }),
  ], ME, { today: TODAY });
  assert.equal(p.total, 4);
  assert.equal(p.done, 2);
  assert.equal(p.percent, 50);
  assert.equal(p.open, 2);
});

test('a cancelled item is neither progress nor a debt', () => {
  const p = progress([t({ status: 'Done' }), t({ status: 'Cancelled' })], ME, { today: TODAY });
  assert.equal(p.total, 1, 'the cancelled one leaves the sum entirely');
  assert.equal(p.percent, 100);
});

test('an empty board reads 0%, not 100%', () => {
  assert.equal(progress([], ME, { today: TODAY }).percent, 0);
  assert.equal(progress([t({ status: 'Cancelled' })], ME, { today: TODAY }).percent, 0);
});

test('overdue does not count work already finished', () => {
  const p = progress([
    t({ status: 'Done', due_date: '2026-01-01' }),
    t({ status: 'To Do', due_date: '2026-01-01' }),
  ], ME, { today: TODAY });
  assert.equal(p.overdue, 1);
});

test('every pipeline stage appears in the counts, even at zero', () => {
  const p = progress([t({ status: 'To Do' })], ME, { today: TODAY });
  for (const stage of PIPELINE) assert.equal(typeof p.byStage[stage], 'number', stage);
  assert.equal(p.byStage.Blocked, 0);
});

test('Delete is offered only for work you set yourself — what 0113 permits', () => {
  assert.equal(isSelfSet(t({ assigned_by: ME }), ME), true);
  assert.equal(isSelfSet(t({ assigned_by: 'boss' }), ME), false, 'your head withdraws their own');
  assert.equal(isSelfSet(t({ employee_id: 'other' }), ME), false);
  assert.equal(isSelfSet(null, ME), false);
});

test('a missing or empty list is an empty board, not a crash', () => {
  assert.deepEqual(myBoard(undefined, ME).open, []);
  assert.deepEqual(sortForMe(), []);
  assert.equal(progress(undefined, ME).total, 0);
});

// ----------------------------------------------------- a task with several people ----
//
// 0114: "my plate" became set membership. A task with three people on it belongs on all three of
// their lists — before this, one of them saw it and the other two never learned they were on it.

const shared = (ids, over = {}) => t({
  employee_id: ids[0],
  assignees: ids.map((id) => ({ employee_id: id, employee: { id, full_name: id } })),
  ...over,
});

test('a task somebody else is primary on is still on my list', () => {
  const board = myBoard([shared(['boss', ME], { title: 'shared' })], ME, { today: TODAY });
  assert.equal(board.open.length, 1);
});

test('a task I am not on stays off my list, however many people are on it', () => {
  const board = myBoard([shared(['boss', 'other'], { title: 'theirs' })], ME, { today: TODAY });
  assert.equal(board.open.length, 0);
});

test('my progress counts the shared work I am actually on', () => {
  const p = progress(
    [shared(['boss', ME], { title: 'a', status: 'Done' }), shared(['boss'], { title: 'b' })],
    ME,
    { today: TODAY }
  );
  assert.equal(p.total, 1);
  assert.equal(p.done, 1);
  assert.equal(p.percent, 100);
});

test('a single-assignee task from before 0114 is still mine', () => {
  const board = myBoard([t({ title: 'old', employee_id: ME })], ME, { today: TODAY });
  assert.equal(board.open.length, 1);
});

test('being added to a task does not make it mine to delete', () => {
  // tasks_delete still asks app.is_own_task(employee_id, ...) AND assigned_by = you. Widening this
  // to the assignee set would offer a Delete the database refuses.
  const theirs = shared(['boss', ME], { title: 'shared', assigned_by: 'boss' });
  assert.equal(isSelfSet(theirs, ME), false);

  const mine = shared([ME], { title: 'mine', assigned_by: ME });
  assert.equal(isSelfSet(mine, ME), true);
});
