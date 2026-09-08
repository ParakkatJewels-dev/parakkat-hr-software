// The Task board's reasoning — filtering, counting, nesting and grouping — with no React in it.
//
// Split out of TaskManagement.jsx for the same reason permissionMatch.js was split out of
// usePermissions.js: the component imports Supabase (through the data hooks and AuthContext), so
// the test runner cannot load it, and every rule below was therefore untested. Three of them were
// wrong. See taskBoard.test.js.
import { istToday, windowStartIso } from './dates.js';   // .js so the node test runner can resolve it, as the .test.js files do

export const TASK_STATUSES = ['To Do', 'In Progress', 'Blocked', 'Done', 'Cancelled'];
export const TASK_PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];

/** Statuses that mean the work is finished with — neither can be overdue, neither is "Active". */
const CLOSED = new Set(['Done', 'Cancelled']);

/**
 * Is this task past its due date?
 *
 * `today` is a parameter so this is testable at any instant, and it defaults to the IST date rather
 * than `new Date().toISOString().slice(0, 10)`. That difference is the whole point: between 00:00
 * and 05:30 IST the UTC date is still yesterday, so the version this replaces reported nothing as
 * overdue during the first five and a half hours of every working day — including on a phone opened
 * at 6am by someone checking what they owe. dates.js has carried the warning since it was written;
 * this file is where it finally gets used.
 */
export function isOverdue(task, today = istToday()) {
  return Boolean(task?.due_date) && task.due_date < today && !CLOSED.has(task.status);
}

/**
 * Everything about a task that a person might type into a search box, as one lowercase string.
 *
 * The employee fields matter as much as the task's own: "who is Anand carrying?" is the question a
 * manager actually asks, and the answer is a search for a person that returns their work. The
 * branch code and department are here for the same reason — "KTM" is how this company refers to a
 * place. Status and priority are included so "blocked" and "urgent" behave like the chips do.
 */
function haystack(t) {
  return [
    t.title, t.description, t.status, t.priority, t.due_date,
    t.assignee?.full_name, t.assignee?.employee_code,
    t.assignee?.branch?.code, t.assignee?.department?.name,
    t.assigner?.full_name, t.assigner?.employee_code,
  ].filter(Boolean).join(' \u0000 ').toLowerCase();
}

/** Words, not a phrase: "anand payroll" should find Anand's payroll task in either order. */
export function searchTerms(query) {
  return String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Free-text search across a set of tasks. EVERY term must match somewhere, so each word the user
 * adds narrows the result rather than widening it.
 *
 * This searches a LIST, and never the database. That is what makes it safe: the list it is given
 * has already been through RLS (which returns only the rows this account may read — an employee's
 * own, a department head's department, a branch manager's branch) and then through the mine-only
 * narrowing in filterTasks. Search can only ever remove rows from that set. A search must never be
 * the thing that decides who sees what, and this one structurally cannot be.
 */
export function searchTasks(tasks, query) {
  const terms = searchTerms(query);
  if (terms.length === 0) return tasks ?? [];
  return (tasks ?? []).filter((t) => {
    const hay = haystack(t);
    return terms.every((term) => hay.includes(term));
  });
}

/** Urgent first. Used for ordering, so the numbers only need to be in the right order. */
const PRIORITY_RANK = { Urgent: 4, High: 3, Medium: 2, Low: 1 };

/**
 * The order a task board should be read in.
 *
 * `created_at desc` — all the list had before — buries the thing that matters: an urgent task that
 * ran over its due date last week sits below every trivial one raised since. So: finished work
 * sinks, what is already late floats, then priority, then the nearest deadline, and only then the
 * newest. Sorting the FILTERED list before the tree is built means sub-tasks come out in the same
 * order under their parent, and each person's list in the By Person view does too.
 */
export function sortTasks(tasks, today = istToday()) {
  const rank = (t) => [
    CLOSED.has(t.status) ? 1 : 0,          // done and cancelled sink
    isOverdue(t, today) ? 0 : 1,           // late work floats
    -(PRIORITY_RANK[t.priority] ?? 0),     // urgent before low
    t.due_date || '9999-12-31',            // soonest deadline; undated last
  ];
  return [...(tasks ?? [])].sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    for (let i = 0; i < ra.length; i++) {
      if (ra[i] < rb[i]) return -1;
      if (ra[i] > rb[i]) return 1;
    }
    // Newest first, which is the order the query returns and the order this used to rely on alone.
    return String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
  });
}

/**
 * The visible set: whose tasks, in which status.
 *
 * `myEmployeeId` may be null — an account not linked to an employee owns no tasks, so "mine" is
 * legitimately empty rather than everything.
 */
export function filterTasks(tasks, { mineOnly = false, myEmployeeId = null, statusFilter = 'Active', query = '', today = istToday() } = {}) {
  // Ownership first, then the free text — both are plain row predicates, so the order does not
  // change the answer; it is written this way to make the guarantee obvious. What matters is that
  // the query only ever REMOVES rows from a list RLS and mine-only have already settled. Search
  // that reaches the database instead would be a different, and much easier, thing to get wrong.
  const scoped = searchTasks(
    (tasks ?? []).filter((t) => !mineOnly || t.employee_id === myEmployeeId),
    query
  );
  return scoped.filter((t) => {
    if (statusFilter === 'All') return true;
    if (statusFilter === 'Active') return !CLOSED.has(t.status);
    if (statusFilter === 'Overdue') return isOverdue(t, today);
    return t.status === statusFilter;
  });
}

/** The headline counts. Deliberately NOT filtered by status — they are what the status chips act on. */
export function taskStats(tasks, { mineOnly = false, myEmployeeId = null, query = '', today = istToday() } = {}) {
  // The counts describe the corpus the chips act ON — so they follow mine-only and the search box,
  // but not the status chip itself, which is what they are there to select. Leaving the search out
  // would put "Total 47" next to two results.
  const scope = searchTasks(
    mineOnly ? (tasks ?? []).filter((t) => t.employee_id === myEmployeeId) : (tasks ?? []),
    query
  );
  return {
    total: scope.length,
    todo: scope.filter((t) => t.status === 'To Do').length,
    progress: scope.filter((t) => t.status === 'In Progress').length,
    done: scope.filter((t) => t.status === 'Done').length,
    overdue: scope.filter((t) => isOverdue(t, today)).length,
  };
}

/**
 * Which tasks sit inside a parent loop.
 *
 * A loop is not reachable through this UI today — a sub-task's parent is chosen once, at creation,
 * from a task that already exists. It is reachable through the database, and `parent_task_id` has
 * no constraint stopping it, so one hand-written UPDATE (or a future "move sub-task" action) is
 * enough. The cost of not checking is not a warning: a looped task has a parent, so it is never a
 * root, and the flow view only renders roots — the task and everything under it disappear from the
 * board with nothing to say they exist. Members of the loop are cut loose and rendered as roots.
 *
 * Walks each parent chain once, memoising the verdict, so this stays linear in the number of tasks.
 */
function loopMembers(tasks, ids) {
  const parentOf = new Map(tasks.map((t) => [t.id, t.parent_task_id ?? null]));
  const cyclic = new Set();
  const settled = new Set();

  for (const t of tasks) {
    if (settled.has(t.id)) continue;
    const path = [];
    const onPath = new Set();
    let cur = t.id;
    // Follow parents until the chain leaves the visible set, reaches something already judged, or
    // comes back to a node we are standing on.
    while (cur != null && ids.has(cur) && !settled.has(cur) && !onPath.has(cur)) {
      onPath.add(cur);
      path.push(cur);
      cur = parentOf.get(cur) ?? null;
    }
    // Closed a loop: everything from where it closes onward is in it. Nodes before that point
    // merely hang off the loop — they still nest correctly under a parent that is now a root.
    const closesLoop = cur != null && onPath.has(cur);
    const loopStart = closesLoop ? path.indexOf(cur) : path.length;
    path.forEach((id, i) => {
      if (i >= loopStart) cyclic.add(id);
      settled.add(id);
    });
  }
  return cyclic;
}

/**
 * parent → children, over the FILTERED set: a sub-task whose parent is filtered out is promoted to
 * a root so it is still visible rather than silently dropped along with its parent.
 */
export function buildTaskTree(filtered) {
  const list = filtered ?? [];
  const ids = new Set(list.map((t) => t.id));
  const cyclic = loopMembers(list, ids);
  const childrenOf = new Map();
  const roots = [];

  for (const t of list) {
    const parent = t.parent_task_id && ids.has(t.parent_task_id) && !cyclic.has(t.id) ? t.parent_task_id : null;
    if (parent) {
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent).push(t);
    } else {
      roots.push(t);
    }
  }
  return { roots, childrenOf };
}

/**
 * One group per assignee, ordered by name.
 *
 * Each group carries its own `key`, because the assignee OBJECT can be null while the assignee
 * still exists: `assignee:employees(...)` is an embedded read, so a viewer who can read the task
 * but not that employee's row gets the task with a null join (exactly the hole migration 0024 was
 * written about). Keying the rendered group on `assignee?.id` then hands React the same key for
 * every such person and it renders one group where there are several. `employee_id` is NOT NULL in
 * the schema, so it is always there to key on.
 */
export function groupByPerson(filtered) {
  const groups = new Map();
  for (const t of filtered ?? []) {
    const key = t.assignee?.id ?? t.employee_id ?? 'unassigned';
    if (!groups.has(key)) groups.set(key, { key, assignee: t.assignee ?? null, tasks: [] });
    groups.get(key).tasks.push(t);
  }
  return [...groups.values()].sort((a, b) =>
    (a.assignee?.full_name || '').localeCompare(b.assignee?.full_name || '')
  );
}

/**
 * Identity for the composer panel, so React remounts it when it is pointed somewhere new.
 *
 * The composer holds the title, the assignee and the rest in its own state, seeded from props —
 * and `useState(initial)` ignores `initial` on every render after the first. The panel is inline
 * (FormSection, not a modal), so the board behind it stays clickable: opening "New task", then
 * pressing + on a colleague's task, kept the panel mounted, moved `parentId` to the new parent, and
 * left the OLD assignee in place. The header said one thing and the insert did another. Feeding
 * this to `key` makes each target a fresh panel, which also clears a half-typed abandoned draft.
 */
export function composerKey(composer) {
  if (!composer) return null;
  if (composer.task) return `edit:${composer.task.id}`;
  return `new:${composer.parentId ?? 'root'}:${composer.defaultAssignee ?? ''}`;
}

/**
 * How much finished work the board carries: a year of it.
 *
 * More generous than the 180 days Leave, Expenses and Tickets use, because a closed task is
 * reference material in a way a spent leave day is not — "what did we do at the last audit" is a
 * real question. Open work is not bounded at all; see below.
 */
export const CLOSED_TASK_WINDOW_DAYS = 365;

/**
 * The PostgREST `or=` filter that bounds the task list: everything still open, plus whatever was
 * closed inside the window.
 *
 * Leave, Expenses and Tickets simply cut at `created_at >= windowStartIso(180)` — see the docstring
 * on windowStartIso, which exists so these lists "cannot grow without limit as the company
 * accumulates years of history". Tasks was the one operational list that never adopted it, and it
 * cannot adopt it unchanged: a leave request from eight months ago is history, but a task from
 * eight months ago that is STILL OPEN is work somebody owes, and is exactly what a manager needs
 * to see. Cutting on age alone would hide the most important rows on the board.
 *
 * So the age limit applies only to work that is finished with. Open tasks are self-limiting anyway
 * — people close them — while closed ones are what accumulate forever.
 *
 * Written as "not closed" rather than as a list of the open statuses for two reasons. It fails in
 * the safe direction: a status added later is treated as open and shown, rather than silently
 * dropping off the board. And none of the values contain a space, so the query string cannot end
 * up depending on whether the server reads `+` as a space — `status.in.("To Do",…)` serialises to
 * `"To+Do"` and would quietly match nothing.
 */
export function openOrRecentlyClosedFilter(days = CLOSED_TASK_WINDOW_DAYS) {
  return `status.not.in.(Done,Cancelled),created_at.gte.${windowStartIso(days)}`;
}
