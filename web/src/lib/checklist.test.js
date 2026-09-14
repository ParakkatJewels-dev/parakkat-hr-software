import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isItemDone, sortItems, checklistProgress, statusFromChecklist, nextPosition, tickedBy,
  ownerOf, canTickItem,
} from './checklist.js';

// An item, with only the fields the screen actually reads.
const item = (over = {}) => ({
  id: 'i1', task_id: 't1', title: 'A step', position: 0,
  completed_by: null, completed_at: null, created_at: '2026-09-01T00:00:00Z', ...over,
});
const done = (over = {}) =>
  item({ completed_by: 'emp-1', completed_at: '2026-09-10T09:00:00Z', ...over });

// ------------------------------------------------------------------ done ----

test('an item is done only when BOTH the name and the time are set', () => {
  assert.equal(isItemDone(done()), true);
  assert.equal(isItemDone(item()), false);
  // The database's check constraint stops these reaching us, but the screen must not decide a
  // half-written row is finished if one ever did.
  assert.equal(isItemDone(item({ completed_at: '2026-09-10T09:00:00Z' })), false);
  assert.equal(isItemDone(item({ completed_by: 'emp-1' })), false);
});

test('a missing item is not a done item', () => {
  assert.equal(isItemDone(null), false);
  assert.equal(isItemDone(undefined), false);
});

// --------------------------------------------------------------- progress ----

test('progress counts what is ticked against what there is', () => {
  const p = checklistProgress([done({ id: 'a' }), done({ id: 'b' }), item({ id: 'c' })]);
  assert.deepEqual({ total: p.total, done: p.done, percent: p.percent, allDone: p.allDone },
    { total: 3, done: 2, percent: 67, allDone: false });
});

test('an empty checklist is 0%, not 100% — it has not been completed, it does not exist', () => {
  const p = checklistProgress([]);
  assert.equal(p.percent, 0);
  assert.equal(p.allDone, false, 'nothing done out of nothing is not "all done"');
});

test('allDone needs at least one item', () => {
  assert.equal(checklistProgress([done()]).allDone, true);
  assert.equal(checklistProgress(undefined).allDone, false);
});

// ------------------------------------------------------------------ order ----

test('items read in position order', () => {
  const rows = sortItems([item({ id: 'c', position: 2 }), item({ id: 'a', position: 0 }), item({ id: 'b', position: 1 })]);
  assert.deepEqual(rows.map((i) => i.id), ['a', 'b', 'c']);
});

test('two items sharing a position fall back to oldest first, so the list cannot shuffle', () => {
  const rows = sortItems([
    item({ id: 'later', position: 1, created_at: '2026-09-02T00:00:00Z' }),
    item({ id: 'earlier', position: 1, created_at: '2026-09-01T00:00:00Z' }),
  ]);
  assert.deepEqual(rows.map((i) => i.id), ['earlier', 'later']);
});

test('sorting does not mutate the list it is given', () => {
  const rows = [item({ id: 'b', position: 1 }), item({ id: 'a', position: 0 })];
  sortItems(rows);
  assert.deepEqual(rows.map((i) => i.id), ['b', 'a']);
});

// --------------------------------------------------------------- position ----

test('a new item goes after the last one', () => {
  assert.equal(nextPosition([item({ position: 0 }), item({ position: 4 })]), 5);
});

test('the first item starts at 0', () => {
  assert.equal(nextPosition([]), 0);
});

test('a gap left by a delete is never reused — max, not length', () => {
  // length would return 1 here and collide with the surviving row.
  assert.equal(nextPosition([item({ position: 7 })]), 8);
});

// ----------------------------------------------------- the auto-done rule ----
//
// These mirror app.tg_task_checklist_rollup (migration 0114) branch for branch. The database is the
// authority; if these and the trigger ever disagree, the trigger is right and this is the bug.

test('ticking the last item completes the task', () => {
  assert.equal(statusFromChecklist({ status: 'In Progress' }, [done({ id: 'a' }), done({ id: 'b' })]), 'Done');
});

test('a task already Done with everything ticked is left alone', () => {
  assert.equal(statusFromChecklist({ status: 'Done' }, [done()]), null);
});

test('unticking an item reopens a finished task', () => {
  assert.equal(statusFromChecklist({ status: 'Done' }, [done({ id: 'a' }), item({ id: 'b' })]), 'In Progress');
});

test('reopening goes to In Progress, not To Do — some of it demonstrably happened', () => {
  assert.equal(statusFromChecklist({ status: 'Done' }, [done({ id: 'a' }), item({ id: 'b' })]), 'In Progress');
});

test('a task with NO checklist is never touched, in either direction', () => {
  // Most tasks are one thing with no steps. Those stay entirely hand-driven.
  assert.equal(statusFromChecklist({ status: 'To Do' }, []), null);
  assert.equal(statusFromChecklist({ status: 'Done' }, []), null);
  assert.equal(statusFromChecklist({ status: 'In Progress' }, undefined), null);
});

test('a Cancelled task is never completed or reopened by its checklist', () => {
  // Cancelled is a decision to stop, not a stage on the way anywhere.
  assert.equal(statusFromChecklist({ status: 'Cancelled' }, [done()]), null);
  assert.equal(statusFromChecklist({ status: 'Cancelled' }, [item()]), null);
});

test('a partly-ticked open task stays where it is', () => {
  assert.equal(statusFromChecklist({ status: 'In Progress' }, [done({ id: 'a' }), item({ id: 'b' })]), null);
  assert.equal(statusFromChecklist({ status: 'To Do' }, [item({ id: 'a' })]), null);
});

test('a task with no status at all is left alone rather than guessed at', () => {
  assert.equal(statusFromChecklist({}, [done()]), null);
  assert.equal(statusFromChecklist(null, [done()]), null);
});

test('deleting the last unticked item completes the task — the checklist decides, both ways', () => {
  const before = [done({ id: 'a' }), item({ id: 'b' })];
  assert.equal(statusFromChecklist({ status: 'In Progress' }, before), null);
  const after = before.filter((i) => i.id !== 'b');
  assert.equal(statusFromChecklist({ status: 'In Progress' }, after), 'Done');
});

test('adding an item to a finished task reopens it — the same rule in reverse', () => {
  const after = [done({ id: 'a' }), item({ id: 'new' })];
  assert.equal(statusFromChecklist({ status: 'Done' }, after), 'In Progress');
});

// -------------------------------------------------------------- who did it ----

test('a ticked item names the person who ticked it', () => {
  const by = tickedBy(done({ completer: { id: 'emp-1', full_name: 'Meera' } }));
  assert.equal(by.name, 'Meera');
  assert.equal(by.employeeId, 'emp-1');
  assert.equal(by.at, '2026-09-10T09:00:00Z');
});

test('an unticked item has nobody against it', () => {
  assert.equal(tickedBy(item()), null);
});

test('a tick by somebody the viewer cannot read still shows as done', () => {
  // The embedded employee read comes back empty for a person outside the viewer's scope. The tick
  // is real either way — losing the whole line would be worse than losing the name.
  const by = tickedBy(done({ completer: null }));
  assert.equal(by.name, 'Someone');
  assert.equal(by.employeeId, 'emp-1');
});

// ------------------------------------------------------------ who it is for ----

test('a step names who it is for, separately from who ticked it', () => {
  const who = ownerOf(item({ assigned_to: 'emp-9', owner: { id: 'emp-9', full_name: 'Anand', employee_code: 'P021' } }));
  assert.equal(who.name, 'Anand');
  assert.equal(who.employeeId, 'emp-9');
  assert.equal(who.code, 'P021');
});

test('most steps belong to nobody in particular', () => {
  assert.equal(ownerOf(item()), null);
  assert.equal(ownerOf(null), null);
});

test('an owner the viewer cannot read is still an owner', () => {
  // Same hole as tickedBy: the embedded employee read is empty outside the viewer's scope. Losing
  // the name is survivable; silently showing the line as unowned would invite the wrong person to
  // tick it and then be refused by the database.
  const who = ownerOf(item({ assigned_to: 'emp-9', owner: null }));
  assert.equal(who.name, 'Someone');
  assert.equal(who.employeeId, 'emp-9');
});

// ------------------------------------------------------------- who may tick ----
//
// These mirror app.tg_checklist_tick_guard (migration 0130) branch for branch. The database is the
// authority; if these and the trigger ever disagree, the trigger is right and this is the bug.

test('an unowned step keeps 0114’s rule — anybody on the task may tick it', () => {
  assert.equal(canTickItem(item(), 'emp-1', { onTask: true }), true);
  assert.equal(canTickItem(item(), 'emp-1', { onTask: false }), false);
});

test('an owned step is that person’s alone', () => {
  const owned = item({ assigned_to: 'emp-9' });
  assert.equal(canTickItem(owned, 'emp-9', { onTask: true }), true);
  // On the task, and still refused: ticking writes a name into completed_by, and it must not be
  // possible to put that name on somebody else's effort.
  assert.equal(canTickItem(owned, 'emp-1', { onTask: true }), false);
});

test('the owner may tick even before the board thinks they are on the task', () => {
  // 0130 puts the owner on the task as it names them, so onTask is true by the next refetch. In the
  // window before that the owner is still the owner — the trigger asks assigned_to, not membership.
  assert.equal(canTickItem(item({ assigned_to: 'emp-9' }), 'emp-9', { onTask: false }), true);
});

test('an account with no employee record ticks nothing', () => {
  assert.equal(canTickItem(item(), null, { onTask: true }), false);
  assert.equal(canTickItem(item({ assigned_to: 'emp-9' }), undefined, { onTask: true }), false);
});

test('clearing the owner hands the step back to everyone on the task', () => {
  // The escape hatch for a step owned by somebody on leave, which would otherwise hold the whole
  // task open — the rollup only closes a task when every line is ticked.
  assert.equal(canTickItem(item({ assigned_to: null }), 'emp-1', { onTask: true }), true);
});
