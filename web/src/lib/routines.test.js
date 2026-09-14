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
