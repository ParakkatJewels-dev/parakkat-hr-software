import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  routineForDay, routineProgress, teamRoutineSummary, filterTeamRoutine, stillOwing,
} from './routines.js';

const item = (o) => ({ id: o.id, employee_id: o.emp ?? 'e1', title: o.title ?? o.id,
  sort_order: o.sort ?? 0, is_active: o.active !== false,
  employee: { id: o.emp ?? 'e1', full_name: o.name ?? 'Bindu' } });
const tick = (itemId, day, emp = 'e1') => ({ routine_item_id: itemId, on_date: day, employee_id: emp });

const TODAY = '2026-09-09';
const YESTERDAY = '2026-09-08';

test('a routine shows every active duty, ticked or not', () => {
  const list = routineForDay([item({id:'a'}), item({id:'b'})], [tick('a', TODAY)], 'e1', TODAY);
  assert.deepEqual(list.map((i) => [i.id, i.done]), [['a', true], ['b', false]]);
});

test('yesterday\'s tick does not count for today — that is the whole point', () => {
  // A routine that stayed ticked would say the job was done when it was done once, last week.
  const list = routineForDay([item({id:'a'})], [tick('a', YESTERDAY)], 'e1', TODAY);
  assert.equal(list[0].done, false);
});

test('a retired duty drops off the list without deleting its history', () => {
  const list = routineForDay([item({id:'a'}), item({id:'old', active:false})], [], 'e1', TODAY);
  assert.deepEqual(list.map((i) => i.id), ['a']);
});

test('duties keep the order the head put them in', () => {
  const list = routineForDay(
    [item({id:'c',sort:3}), item({id:'a',sort:1}), item({id:'b',sort:2})], [], 'e1', TODAY);
  assert.deepEqual(list.map((i) => i.id), ['a', 'b', 'c']);
});

test('somebody else\'s tick never marks your duty', () => {
  const list = routineForDay([item({id:'a'})], [tick('a', TODAY, 'someone-else')], 'e1', TODAY);
  assert.equal(list[0].done, false);
});

test('progress counts what is done out of what is owed', () => {
  const list = routineForDay([item({id:'a'}), item({id:'b'}), item({id:'c'})], [tick('a',TODAY)], 'e1', TODAY);
  assert.deepEqual(routineProgress(list), { done: 1, total: 3, complete: false, pct: 33 });
});

test('an empty routine is not "complete" — there was nothing to complete', () => {
  assert.deepEqual(routineProgress([]), { done: 0, total: 0, complete: false, pct: 0 });
});

test('all done reads as complete', () => {
  const list = routineForDay([item({id:'a'})], [tick('a',TODAY)], 'e1', TODAY);
  assert.equal(routineProgress(list).complete, true);
});

// ----------------------------------------------------------- the head's board ----

const TEAM = [
  item({ id:'a1', emp:'anand', name:'Anand', sort:1 }),
  item({ id:'a2', emp:'anand', name:'Anand', sort:2 }),
  item({ id:'b1', emp:'bindu', name:'Bindu', sort:1 }),
  item({ id:'z1', emp:'zara',  name:'Zara',  sort:1 }),
];

test('the people who still owe something come first', () => {
  // A completion board is read to find who has NOT finished. Putting the finished at the top makes
  // you scroll past the answer.
  const ticks = [tick('b1', TODAY, 'bindu'), tick('a1', TODAY, 'anand')];
  const summary = teamRoutineSummary(TEAM, ticks, TODAY);
  assert.deepEqual(summary.map((g) => [g.employee.full_name, g.done, g.total]),
    [['Zara', 0, 1], ['Anand', 1, 2], ['Bindu', 1, 1]]);
});

test('the furthest behind is first among those still owing', () => {
  // Bindu and Zara are both on 0% and tie, so the name breaks it — the order has to be stable day
  // to day or the board reshuffles under the reader for no reason. Anand, on 50%, comes after both.
  const summary = teamRoutineSummary(TEAM, [tick('a1', TODAY, 'anand')], TODAY);
  assert.deepEqual(summary.map((g) => [g.employee.full_name, g.pct]),
    [['Bindu', 0], ['Zara', 0], ['Anand', 50]]);
});

test('nobody with a routine is left off the board', () => {
  assert.equal(teamRoutineSummary(TEAM, [], TODAY).length, 3);
});

test('an empty team is not a crash', () => {
  assert.deepEqual(teamRoutineSummary([], [], TODAY), []);
  assert.deepEqual(teamRoutineSummary(undefined, undefined, TODAY), []);
});

// ------------------------------------------------- searching the head's board ----

// Anand has two duties and one tick (50%), Bindu one and one (finished), Zara one and none (0%).
const CODED = [
  item({ id:'a1', emp:'anand', name:'Anand', sort:1 }),
  item({ id:'a2', emp:'anand', name:'Anand', sort:2 }),
  item({ id:'b1', emp:'bindu', name:'Bindu', sort:1 }),
  item({ id:'z1', emp:'zara',  name:'Zara',  sort:1 }),
].map((i) => ({ ...i, employee: { ...i.employee, employee_code: `P-${i.employee_id.slice(0, 2)}` } }));
const BOARD = teamRoutineSummary(CODED, [tick('a1', TODAY, 'anand'), tick('b1', TODAY, 'bindu')], TODAY);

const names = (groups) => groups.map((g) => g.employee.full_name);

test('searching finds a person by name', () => {
  assert.deepEqual(names(filterTeamRoutine(BOARD, { query: 'bindu' })), ['Bindu']);
});

test('searching finds a person by employee code', () => {
  assert.deepEqual(names(filterTeamRoutine(BOARD, { query: 'P-za' })), ['Zara']);
});

test('search is case-insensitive and ignores surrounding space', () => {
  assert.deepEqual(names(filterTeamRoutine(BOARD, { query: '  ANAND ' })), ['Anand']);
});

test('every word must match, so each one typed narrows the list', () => {
  assert.deepEqual(names(filterTeamRoutine(BOARD, { query: 'anand P-an' })), ['Anand']);
  assert.deepEqual(names(filterTeamRoutine(BOARD, { query: 'anand bindu' })), []);
});

test('an empty search is not a filter', () => {
  assert.equal(filterTeamRoutine(BOARD, { query: '   ' }).length, 3);
  assert.equal(filterTeamRoutine(BOARD, {}).length, 3);
});

test('"still owing" hides the people who have finished', () => {
  assert.deepEqual(names(filterTeamRoutine(BOARD, { status: 'owing' })), ['Zara', 'Anand']);
});

test('"finished" shows only the people who are done', () => {
  assert.deepEqual(names(filterTeamRoutine(BOARD, { status: 'finished' })), ['Bindu']);
});

test('the search and the status filter both apply', () => {
  assert.deepEqual(names(filterTeamRoutine(BOARD, { query: 'bindu', status: 'owing' })), []);
  assert.deepEqual(names(filterTeamRoutine(BOARD, { query: 'bindu', status: 'finished' })), ['Bindu']);
});

test('filtering keeps each card describing that person’s WHOLE day', () => {
  // The trap this function exists to avoid: narrowing the duties instead of the people would show
  // Anand as "1 of 1" when he has two duties and has done one of them.
  const [anand] = filterTeamRoutine(BOARD, { query: 'anand' });
  assert.deepEqual([anand.done, anand.total, anand.pct], [1, 2, 50]);
  assert.equal(anand.list.length, 2);
});

test('filtering does not reorder — the furthest behind stays first', () => {
  assert.deepEqual(names(filterTeamRoutine(BOARD, {})), ['Zara', 'Anand', 'Bindu']);
});

test('an empty board filters to nothing rather than crashing', () => {
  assert.deepEqual(filterTeamRoutine([], { query: 'x' }), []);
  assert.deepEqual(filterTeamRoutine(undefined, {}), []);
});

test('the count on the filter is how many people still owe something', () => {
  assert.equal(stillOwing(BOARD), 2);
  assert.equal(stillOwing([]), 0);
  assert.equal(stillOwing(undefined), 0);
});

const {
  routineScheduleLabel, groupRoutineDay, filterRoutineGroups, summarizeRoutineStats, filterRoutineStats,
} = await import('./routines.js');

const scheduledJobs = [
  { id: 'a', routine_id: 'opening', routine_name: 'Opening checks', employee_id: 'e1', title: 'Unlock', sort_order: 1, done: true, frequency: 'daily', can_manage: true },
  { id: 'b', routine_id: 'opening', routine_name: 'Opening checks', employee_id: 'e1', title: 'Inspect', sort_order: 2, done: false, frequency: 'daily', can_manage: true },
  { id: 'c', routine_id: 'report', routine_name: 'Weekly report', employee_id: 'e1', title: 'Submit', done: false, frequency: 'weekly', can_manage: false },
];

test('named routines keep all jobs in their progress when filtering by a matching job', () => {
  const groups = groupRoutineDay(scheduledJobs);
  assert.equal(groups.length, 2);
  const [group] = filterRoutineGroups(groups, { query: 'unlock', status: 'owing', frequency: 'daily' });
  assert.equal(group.done, 1);
  assert.equal(group.total, 2);
  assert.equal(group.pct, 50);
  assert.equal(group.canManage, true);
  assert.equal(filterRoutineGroups(groups, { status: 'finished' }).length, 0);
  assert.equal(filterRoutineGroups(groups, { frequency: 'weekly' })[0].canManage, false);
});

test('statistics filter by current designation and scope without changing occurrence weights', () => {
  const rows = [
    { routine_id: 'r1', scheduled: 6, completed: 3, missed: 2, pending: 1, frequency: 'daily', employee: { full_name: 'Asha', designation_id: 'cashier', department_id: 'sales', branch_id: 'north' } },
    { routine_id: 'r2', scheduled: 1, completed: 1, missed: 0, pending: 0, frequency: 'weekly', employee: { full_name: 'Binu', designation_id: 'cashier', department_id: 'sales', branch_id: 'south' } },
    { routine_id: 'r3', scheduled: 0, completed: 0, unscored_done_jobs: 2, employee: { full_name: 'Legacy', designation_id: 'manager', department_id: 'office' } },
  ];
  assert.deepEqual(summarizeRoutineStats(rows), { scheduled: 7, completed: 4, missed: 2, pending: 1, unscored_done_jobs: 2, pct: 57 });
  assert.equal(filterRoutineStats(rows, { designationId: 'cashier' }).length, 2);
  assert.equal(filterRoutineStats(rows, { designationId: 'cashier', branchId: 'north', departmentId: 'sales', status: 'owing' })[0].routine_id, 'r1');
  assert.equal(filterRoutineStats(rows, { status: 'finished' })[0].routine_id, 'r2');
  assert.equal(filterRoutineStats(rows, { status: 'owing' }).length, 1, 'unknown historic denominator is not a missed routine');
  assert.equal(filterRoutineStats(rows, { query: 'binu', frequency: 'weekly' }).length, 1);
});

test('schedule labels explain monthly clamping and selected weekdays', () => {
  assert.equal(routineScheduleLabel({ frequency: 'weekly', weekdays: [5, 1] }), 'Weekly · Mon, Fri');
  assert.match(routineScheduleLabel({ frequency: 'monthly', month_day: 31 }), /31.*last day/);
  assert.equal(routineScheduleLabel({ frequency: 'interval', interval_days: 14 }), 'Every 14 days');
  assert.equal(routineScheduleLabel({ frequency: 'once', start_date: '2026-10-01' }), 'Once · 2026-10-01');
});
