import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isOverdue, filterTasks, taskStats, composerKey,
  searchTasks, searchTerms, sortTasks,
  openOrRecentlyClosedFilter, CLOSED_TASK_WINDOW_DAYS, TASK_STATUSES,
  assigneeIds, isAssignedTo, assigneesOf,
} from './taskBoard.js';

// A task, with only the fields the board actually reads.
const task = (over = {}) => ({
  id: 'id', employee_id: 'me', parent_task_id: null,
  status: 'To Do', priority: 'Medium', due_date: null, assignee: null, ...over,
});

// ---------------------------------------------------------------- overdue ----

test('a task due before today is overdue', () => {
  assert.equal(isOverdue(task({ due_date: '2026-09-07' }), '2026-09-08'), true);
});

test('a task due today is not yet overdue — the day is not over', () => {
  assert.equal(isOverdue(task({ due_date: '2026-09-08' }), '2026-09-08'), false);
});

test('a task with no due date can never be overdue', () => {
  assert.equal(isOverdue(task({ due_date: null }), '2026-09-08'), false);
});

test('finished work is not overdue, however late it was', () => {
  for (const status of ['Done', 'Cancelled']) {
    assert.equal(isOverdue(task({ due_date: '2020-01-01', status }), '2026-09-08'), false, status);
  }
});

test('blocked work still runs late — being stuck is exactly when you want to know', () => {
  assert.equal(isOverdue(task({ due_date: '2026-09-07', status: 'Blocked' }), '2026-09-08'), true);
});

test('overdue is read against the IST date, not the browser\'s UTC one', () => {
  // 02:00 IST on the 8th is still the 7th in UTC. The version this replaces asked
  // `new Date().toISOString().slice(0, 10)`, so from midnight to 05:30 every morning it compared
  // against yesterday and reported an overdue task as on time.
  const clock = new Date('2026-09-07T20:30:00Z');       // == 2026-09-08 02:00 IST
  const original = Date;
  globalThis.Date = class extends original {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock.getTime(); }
  };
  try {
    // No `today` passed: this is the default path the component uses.
    assert.equal(isOverdue(task({ due_date: '2026-09-07' })), true);
    assert.equal(isOverdue(task({ due_date: '2026-09-08' })), false);
  } finally {
    globalThis.Date = original;
  }
});

// --------------------------------------------------------------- filtering ----

const board = [
  task({ id: 'a', status: 'To Do', employee_id: 'me' }),
  task({ id: 'b', status: 'In Progress', employee_id: 'you' }),
  task({ id: 'c', status: 'Done', employee_id: 'me' }),
  task({ id: 'd', status: 'Cancelled', employee_id: 'you' }),
  task({ id: 'e', status: 'Blocked', employee_id: 'me', due_date: '2026-09-01' }),
];
const ids = (list) => list.map((t) => t.id);
const TODAY = '2026-09-08';

test('due-date sorting puts dated open work first and closed work last', () => {
  const input = [
    task({ id: 'undated', priority: 'Urgent' }),
    task({ id: 'finished', status: 'Done', due_date: '2020-01-01' }),
    task({ id: 'later', due_date: '2026-10-01', priority: 'Urgent' }),
    task({ id: 'sooner', due_date: '2026-09-10', priority: 'Low' }),
  ];
  assert.deepEqual(ids(sortTasks(input, TODAY, 'due')), ['sooner', 'later', 'undated', 'finished']);
  assert.deepEqual(ids(input), ['undated', 'finished', 'later', 'sooner'], 'does not mutate the query cache');
});

test('priority sorting puts urgent work ahead of older low-priority work', () => {
  const input = [
    task({ id: 'low', priority: 'Low', due_date: '2020-01-01' }),
    task({ id: 'closed', status: 'Cancelled', priority: 'Urgent' }),
    task({ id: 'high', priority: 'High' }),
    task({ id: 'urgent', priority: 'Urgent' }),
  ];
  assert.deepEqual(ids(sortTasks(input, TODAY, 'priority')), ['urgent', 'high', 'low', 'closed']);
});

test('title sorting is case-insensitive and natural for numbered tasks', () => {
  const input = [
    task({ id: '10', title: 'Task 10' }),
    task({ id: '2', title: 'task 2' }),
    task({ id: 'a', title: 'Audit', status: 'Done' }),
  ];
  assert.deepEqual(ids(sortTasks(input, TODAY, 'title')), ['a', '2', '10']);
});

test('newest sorting uses creation date across all visible statuses, with missing dates last', () => {
  const input = [
    task({ id: 'missing' }),
    task({ id: 'old', created_at: '2026-01-01T00:00:00Z' }),
    task({ id: 'new', status: 'Done', created_at: '2026-09-08T00:00:00Z' }),
  ];
  assert.deepEqual(ids(sortTasks(input, TODAY, 'newest')), ['new', 'old', 'missing']);
});

test('display sorting happens before slicing a filtered page', () => {
  const input = Array.from({ length: 23 }, (_, index) => task({
    id: String(index), title: `Task ${23 - index}`,
  }));
  const sorted = sortTasks(filterTasks(input, { statusFilter: 'Active', today: TODAY }), TODAY, 'title');
  assert.equal(sorted[0].title, 'Task 1');
  assert.equal(sorted.slice(10, 20)[0].title, 'Task 11');
  assert.equal(sorted.slice(20).length, 3);
});

test('Active hides what is finished with', () => {
  assert.deepEqual(ids(filterTasks(board, { statusFilter: 'Active', today: TODAY })), ['a', 'b', 'e']);
});

test('All shows everything, cancelled included', () => {
  assert.deepEqual(ids(filterTasks(board, { statusFilter: 'All', today: TODAY })), ['a', 'b', 'c', 'd', 'e']);
});

test('Overdue is its own filter, not a status', () => {
  assert.deepEqual(ids(filterTasks(board, { statusFilter: 'Overdue', today: TODAY })), ['e']);
});

test('a named status matches only that status', () => {
  assert.deepEqual(ids(filterTasks(board, { statusFilter: 'Done', today: TODAY })), ['c']);
});

test('mine-only narrows to the signed-in employee before the status filter', () => {
  assert.deepEqual(
    ids(filterTasks(board, { mineOnly: true, myEmployeeId: 'me', statusFilter: 'All', today: TODAY })),
    ['a', 'c', 'e']
  );
});

test('an account with no employee record owns nothing, rather than everything', () => {
  // The forced narrowing an ESS viewer gets. Reading `!==` against undefined must not pass.
  assert.deepEqual(
    ids(filterTasks(board, { mineOnly: true, myEmployeeId: null, statusFilter: 'All', today: TODAY })),
    []
  );
});

// ------------------------------------------------------------------ counts ----

test('the counts describe the whole board, not the current status filter', () => {
  assert.deepEqual(taskStats(board, { today: TODAY }), {
    total: 5, todo: 1, progress: 1, done: 1, overdue: 1,
  });
});

test('the counts follow mine-only, so the chips agree with the list below them', () => {
  assert.deepEqual(taskStats(board, { mineOnly: true, myEmployeeId: 'me', today: TODAY }), {
    total: 3, todo: 1, progress: 0, done: 1, overdue: 1,
  });
});

// ------------------------------------------------------------------ composer ----

test('pointing the composer at a different person gives it a different identity', () => {
  // Fed to `key`, so React remounts the panel rather than keeping a half-typed draft aimed at
  // somebody else — useState ignores its initial value on every render after the first.
  assert.notEqual(
    composerKey({ defaultAssignee: 'emp-A' }),
    composerKey({ defaultAssignee: 'emp-B' })
  );
});

test('re-opening the same target keeps the same panel, so a draft is not thrown away', () => {
  assert.equal(
    composerKey({ defaultAssignee: 'emp-A' }),
    composerKey({ defaultAssignee: 'emp-A' })
  );
});

test('a closed composer has no key', () => {
  assert.equal(composerKey(null), null);
});


// ------------------------------------------------------------------- search ----

const person = (id, name, code, branch, dept) => ({
  id, full_name: name, employee_code: code,
  branch: branch ? { code: branch } : null,
  department: dept ? { name: dept } : null,
});

const searchable = [
  task({ id: 's1', title: 'Close Q2 payroll', description: 'Reconcile PF and ESI', priority: 'Urgent',
         employee_id: 'emp-me', assignee: person('emp-me', 'Kasinath P', 'PJ001', 'HO', 'Finance') }),
  task({ id: 's2', title: 'Fix biometric reader', status: 'Blocked',
         employee_id: 'emp-a', assignee: person('emp-a', 'Anand Kumar', 'PJ014', 'KTM', 'IT'),
         assigner: person('emp-me', 'Kasinath P', 'PJ001') }),
  task({ id: 's3', title: 'Stock audit', employee_id: 'emp-z',
         assignee: person('emp-z', 'Zara Nair', 'PJ099', 'TVM', 'Retail') }),
];
const hits = (q, list = searchable) => searchTasks(list, q).map((t) => t.id);

test('an empty query is not a filter', () => {
  assert.deepEqual(hits(''), ['s1', 's2', 's3']);
  assert.deepEqual(hits('   '), ['s1', 's2', 's3']);
});

test('a task is found by its title', () => {
  assert.deepEqual(hits('payroll'), ['s1']);
});

test('a task is found by its description', () => {
  assert.deepEqual(hits('esi'), ['s1']);
});

test('searching a person returns that person\'s work', () => {
  assert.deepEqual(hits('anand'), ['s2']);
  assert.deepEqual(hits('zara nair'), ['s3']);
});

test('an employee code finds their tasks — it is what the code is for', () => {
  assert.deepEqual(hits('pj014'), ['s2']);
});

test('a branch code finds that branch\'s work', () => {
  assert.deepEqual(hits('ktm'), ['s2']);
});

test('a department finds its work', () => {
  assert.deepEqual(hits('finance'), ['s1']);
});

test('status and priority are searchable, like the chips', () => {
  assert.deepEqual(hits('blocked'), ['s2']);
  assert.deepEqual(hits('urgent'), ['s1']);
});

test('who assigned it is searchable too', () => {
  // s2 was delegated by Kasinath: findable from either end of the delegation.
  assert.ok(hits('kasinath').includes('s2'));
});

test('every word must match — more words narrow, never widen', () => {
  assert.deepEqual(hits('anand biometric'), ['s2']);
  assert.deepEqual(hits('anand payroll'), []);
});

test('word order does not matter', () => {
  assert.deepEqual(hits('biometric anand'), hits('anand biometric'));
});

test('search is case-insensitive', () => {
  assert.deepEqual(hits('ANAND'), hits('anand'));
});

test('fields cannot be run together to make a false match', () => {
  // Without a separator between them, "PJ001" + "Kasinath" would concatenate into a string that
  // "pj001kasinath" matches. Adjacent fields are separated, so it does not.
  assert.deepEqual(hits('pj001kasinath'), []);
});

test('searchTerms splits on any run of whitespace', () => {
  assert.deepEqual(searchTerms('  anand   payroll \n'), ['anand', 'payroll']);
});

// ------------------------------------------------- search cannot widen a view ----

test('an employee searching a colleague by name finds nothing', () => {
  // THE security-shaped case. RLS would not have returned the colleague's row in the first place,
  // but this list is filtered in the browser, so the rule has to hold here too: mine-only is
  // applied BEFORE the query, so no string can reach past it.
  const asEmployee = { mineOnly: true, myEmployeeId: 'emp-me', statusFilter: 'All', today: TODAY };
  assert.deepEqual(filterTasks(searchable, { ...asEmployee, query: 'anand' }).map((t) => t.id), []);
  assert.deepEqual(filterTasks(searchable, { ...asEmployee, query: 'biometric' }).map((t) => t.id), []);
  assert.deepEqual(filterTasks(searchable, { ...asEmployee, query: 'ktm' }).map((t) => t.id), []);
});

test('an employee searching their own work still finds it', () => {
  assert.deepEqual(
    filterTasks(searchable, { mineOnly: true, myEmployeeId: 'emp-me', statusFilter: 'All', query: 'payroll', today: TODAY }).map((t) => t.id),
    ['s1']
  );
});

test('a manager searching the same name does find it', () => {
  // Same query, same code path — the only difference is what the viewer is allowed to be shown.
  assert.deepEqual(
    filterTasks(searchable, { mineOnly: false, myEmployeeId: 'emp-me', statusFilter: 'All', query: 'anand', today: TODAY }).map((t) => t.id),
    ['s2']
  );
});

test('the status chip still applies on top of a search', () => {
  assert.deepEqual(
    filterTasks(searchable, { statusFilter: 'Blocked', query: 'anand', today: TODAY }).map((t) => t.id),
    ['s2']
  );
  assert.deepEqual(
    filterTasks(searchable, { statusFilter: 'Done', query: 'anand', today: TODAY }).map((t) => t.id),
    []
  );
});

test('the counts follow the search, so the chips describe what is on screen', () => {
  assert.deepEqual(taskStats(searchable, { query: 'anand', today: TODAY }), {
    total: 1, todo: 0, progress: 0, done: 0, overdue: 0,
  });
});

test('an employee\'s counts never describe anyone else\'s work', () => {
  assert.equal(taskStats(searchable, { mineOnly: true, myEmployeeId: 'emp-me', query: 'anand', today: TODAY }).total, 0);
});

// --------------------------------------------------------------------- order ----

test('finished work sinks below everything still open', () => {
  const order = sortTasks([
    task({ id: 'done', status: 'Done', priority: 'Urgent' }),
    task({ id: 'open', status: 'To Do', priority: 'Low' }),
  ], TODAY).map((t) => t.id);
  assert.deepEqual(order, ['open', 'done']);
});

test('what is already late comes first, whatever its priority', () => {
  const order = sortTasks([
    task({ id: 'urgent-later', priority: 'Urgent', due_date: '2026-12-01' }),
    task({ id: 'low-late', priority: 'Low', due_date: '2026-09-01' }),
  ], TODAY).map((t) => t.id);
  assert.deepEqual(order, ['low-late', 'urgent-later']);
});

test('among work that is on time, priority decides', () => {
  const order = sortTasks([
    task({ id: 'low', priority: 'Low' }),
    task({ id: 'urgent', priority: 'Urgent' }),
    task({ id: 'medium', priority: 'Medium' }),
    task({ id: 'high', priority: 'High' }),
  ], TODAY).map((t) => t.id);
  assert.deepEqual(order, ['urgent', 'high', 'medium', 'low']);
});

test('at equal priority the nearer deadline wins, and an undated task goes last', () => {
  const order = sortTasks([
    task({ id: 'undated', priority: 'High' }),
    task({ id: 'december', priority: 'High', due_date: '2026-12-01' }),
    task({ id: 'october', priority: 'High', due_date: '2026-10-01' }),
  ], TODAY).map((t) => t.id);
  assert.deepEqual(order, ['october', 'december', 'undated']);
});

test('everything else equal, the newest is first — the old behaviour, as the last tiebreak', () => {
  const order = sortTasks([
    task({ id: 'older', created_at: '2026-01-01T00:00:00Z' }),
    task({ id: 'newer', created_at: '2026-06-01T00:00:00Z' }),
  ], TODAY).map((t) => t.id);
  assert.deepEqual(order, ['newer', 'older']);
});

test('sorting does not mutate the list it is given', () => {
  const input = [task({ id: 'a', priority: 'Low' }), task({ id: 'b', priority: 'Urgent' })];
  const before = input.map((t) => t.id);
  sortTasks(input, TODAY);
  assert.deepEqual(input.map((t) => t.id), before);
});

test('editing a task is a different panel from creating one', () => {
  // Otherwise pressing the pencil while the New-task panel is open would leave the typed draft in
  // place and quietly turn it into an edit of somebody else's task.
  assert.notEqual(
    composerKey({ task: { id: 'p1' } }),
    composerKey({ defaultAssignee: 'emp-A' })
  );
});

test('editing two different tasks gives two different panels', () => {
  assert.notEqual(composerKey({ task: { id: 't1' } }), composerKey({ task: { id: 't2' } }));
});

// ------------------------------------------------------- what the board loads ----

test('the window keeps every open task and bounds only what is finished', () => {
  const f = openOrRecentlyClosedFilter(365);
  // Two arms, OR'd by PostgREST: "not closed" carries no date, so open work never ages off.
  const [openArm, dateArm] = f.split(',created_at');
  assert.equal(openArm, 'status.not.in.(Done,Cancelled)');
  assert.match(dateArm, /^\.gte\.\d{4}-\d{2}-\d{2}$/);
});

test('the age limit is a real date, N days back', () => {
  const day = (f) => f.match(/gte\.(\d{4}-\d{2}-\d{2})/)[1];
  const near = new Date(day(openOrRecentlyClosedFilter(1)));
  const far = new Date(day(openOrRecentlyClosedFilter(365)));
  assert.ok(far < near, 'a longer window must reach further back');
  assert.equal(Math.round((near - far) / 86400000), 364);
});

test('no value in the filter contains a space', () => {
  // The trap this formulation exists to avoid. Written the obvious way — as a positive list of the
  // open statuses — the filter carries "To Do" and "In Progress", and the query string serialises
  // those spaces as `+`. If the server reads `+` literally the filter matches NOTHING, the board
  // silently shows only recent work, and there is no error anywhere to say so.
  assert.ok(!openOrRecentlyClosedFilter().includes(' '));
  assert.ok(!openOrRecentlyClosedFilter().includes('+'));
});

test('the filter names the closed statuses, so a NEW status is shown rather than hidden', () => {
  // Fails safe: `not.in.(Done,Cancelled)` treats anything added later as open. A positive list
  // would drop a new status off the board with nobody noticing.
  const f = openOrRecentlyClosedFilter();
  for (const closed of ['Done', 'Cancelled']) assert.ok(f.includes(closed));
  for (const open of TASK_STATUSES.filter((s) => !['Done', 'Cancelled'].includes(s))) {
    assert.ok(!f.includes(open), `${open} must not be enumerated in the filter`);
  }
});

test('the window is stated in a form the UI can put on screen', () => {
  assert.equal(typeof CLOSED_TASK_WINDOW_DAYS, 'number');
  assert.ok(CLOSED_TASK_WINDOW_DAYS >= 180, 'shorter than the other lists would be a surprise');
});

// ------------------------------------------------------------- who is on it ----
//
// Since 0114 a task can carry several people. `employee_id` is still the PRIMARY — the one whose
// branch and department the row is stamped with, and therefore which managers see it — but every
// question the board asks about ownership is now set membership.

const withPeople = (ids, over = {}) => task({
  employee_id: ids[0],
  assignees: ids.map((id) => ({ employee_id: id, employee: { id, full_name: `Name ${id}` } })),
  ...over,
});

test('a task lists everybody on it, not just the primary', () => {
  assert.deepEqual(assigneeIds(withPeople(['a', 'b', 'c'])), ['a', 'b', 'c']);
});

test('a task from before 0114 falls back to its single assignee', () => {
  // The junction read can also come back empty for a viewer who cannot see those employee rows —
  // the 0024 hole. Reading that as "belongs to nobody" would drop the task off its owner's list.
  assert.deepEqual(assigneeIds(task({ employee_id: 'solo', assignees: [] })), ['solo']);
  assert.deepEqual(assigneeIds(task({ employee_id: 'solo' })), ['solo']);
});

test('a task with no assignee at all belongs to nobody, rather than to undefined', () => {
  assert.deepEqual(assigneeIds({ }), []);
  assert.equal(isAssignedTo({ }, 'a'), false);
});

test('everyone on the task is assigned to it, primary or not', () => {
  const t = withPeople(['a', 'b']);
  assert.equal(isAssignedTo(t, 'a'), true);
  assert.equal(isAssignedTo(t, 'b'), true);
  assert.equal(isAssignedTo(t, 'c'), false);
});

test('nobody is assigned to a task by having no employee record', () => {
  assert.equal(isAssignedTo(withPeople(['a']), null), false);
  assert.equal(isAssignedTo(withPeople(['a']), undefined), false);
});

test('the primary leads the rendered list, whatever order the rows arrived in', () => {
  const t = task({
    employee_id: 'boss',
    assignees: [
      { employee_id: 'helper', employee: { id: 'helper', full_name: 'Helper' } },
      { employee_id: 'boss', employee: { id: 'boss', full_name: 'Boss' } },
    ],
  });
  const rows = assigneesOf(t);
  assert.deepEqual(rows.map((r) => r.id), ['boss', 'helper']);
  assert.equal(rows[0].isPrimary, true);
});

test('a person listed twice is rendered once — a duplicate key renders one row for two people', () => {
  const t = task({
    employee_id: 'a',
    assignees: [
      { employee_id: 'a', employee: { id: 'a', full_name: 'A' } },
      { employee_id: 'a', employee: { id: 'a', full_name: 'A' } },
    ],
  });
  assert.equal(assigneesOf(t).length, 1);
});

test('mine-only keeps a task somebody else is primary on', () => {
  // The whole point of multi-assignee on a phone: work you were added to is your work.
  const rows = filterTasks([withPeople(['boss', 'me'])], { mineOnly: true, myEmployeeId: 'me', statusFilter: 'All' });
  assert.equal(rows.length, 1);
});

test('the counts agree with that list', () => {
  const stats = taskStats([withPeople(['boss', 'me']), withPeople(['boss'])], { mineOnly: true, myEmployeeId: 'me' });
  assert.equal(stats.total, 1);
});

// ------------------------------------------------------------ person filter ----
//
// What the By Person view used to answer, as a narrowing of the one board.

test('the person filter keeps only that person\'s work', () => {
  const rows = filterTasks(
    [withPeople(['a']), withPeople(['b']), withPeople(['b', 'a'])],
    { personId: 'a', statusFilter: 'All' }
  );
  assert.equal(rows.length, 2, 'a task they are second on is still theirs');
});

test('no person filter is Everyone, not nobody', () => {
  const rows = filterTasks([withPeople(['a']), withPeople(['b'])], { personId: '', statusFilter: 'All' });
  assert.equal(rows.length, 2);
});

test('the person filter and mine-only both apply, and can be contradictory', () => {
  const rows = filterTasks(
    [withPeople(['a']), withPeople(['me'])],
    { personId: 'a', mineOnly: true, myEmployeeId: 'me', statusFilter: 'All' }
  );
  assert.equal(rows.length, 0, 'asking for their work among yours is legitimately empty');
});

test('the counts follow the person filter too, so the chips describe what is on screen', () => {
  const stats = taskStats([withPeople(['a']), withPeople(['b'])], { personId: 'a' });
  assert.equal(stats.total, 1);
});

test('searching a name finds a task that person is second on', () => {
  const t = task({
    employee_id: 'boss',
    assignee: { full_name: 'Boss Person' },
    assignees: [
      { employee_id: 'boss', employee: { id: 'boss', full_name: 'Boss Person' } },
      { employee_id: 'anand', employee: { id: 'anand', full_name: 'Anand K', employee_code: 'E77' } },
    ],
  });
  assert.equal(searchTasks([t], 'anand').length, 1);
  assert.equal(searchTasks([t], 'E77').length, 1, 'their code finds it too');
});
