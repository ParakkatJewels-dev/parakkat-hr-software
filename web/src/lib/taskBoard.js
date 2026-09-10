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
 * Everyone carrying this task.
 *
 * A task used to have exactly one assignee — `employee_id`, NOT NULL — and every question about
 * ownership was a comparison against it. Since 0114 the real answer lives in `task_assignees`, and
 * `employee_id` is only the PRIMARY: the one whose org path the row wears, because that is what the
 * ancestry columns and therefore every manager's scope are stamped from.
 *
 * The fallback matters. `assignees` arrives from an embedded read, and an embedded read comes back
 * empty for a viewer who cannot see those employee rows — the same hole 0024 was written about. An
 * empty array there would mean "this task belongs to nobody", which would drop it off its own
 * assignee's list. Falling back to the primary keeps the pre-0114 answer, which is never wrong,
 * only sometimes incomplete.
 */
export function assigneeIds(task) {
  const rows = task?.assignees;
  if (Array.isArray(rows) && rows.length > 0) {
    return rows.map((r) => r.employee_id ?? r.employee?.id).filter(Boolean);
  }
  return task?.employee_id ? [task.employee_id] : [];
}

/** Is this person carrying this task? Primary or otherwise — the board draws no distinction. */
export function isAssignedTo(task, employeeId) {
  return Boolean(employeeId) && assigneeIds(task).includes(employeeId);
}

/** The people on a task, as rows to render — name and code, primary first. */
export function assigneesOf(task) {
  const rows = Array.isArray(task?.assignees) ? task.assignees : [];
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const id = r.employee_id ?? r.employee?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, employee: r.employee ?? null, isPrimary: id === task?.employee_id });
  }
  // The primary leads: they are who the task is scoped to, so their branch is the one that decides
  // which managers see it, and a reader scanning avatars should meet that person first.
  out.sort((a, b) => (a.isPrimary === b.isPrimary ? 0 : a.isPrimary ? -1 : 1));
  if (out.length === 0 && task?.employee_id) {
    return [{ id: task.employee_id, employee: task.assignee ?? null, isPrimary: true }];
  }
  return out;
}

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
  // Every assignee, not only the primary. "who is Anand carrying" has to find a task Anand is the
  // third name on, or search quietly answers a different question than the one asked.
  const others = (Array.isArray(t.assignees) ? t.assignees : [])
    .flatMap((r) => [r.employee?.full_name, r.employee?.employee_code]);
  return [
    t.title, t.description, t.status, t.priority, t.due_date,
    t.assignee?.full_name, t.assignee?.employee_code,
    t.assignee?.branch?.code, t.assignee?.department?.name,
    t.assigner?.full_name, t.assigner?.employee_code,
    ...others,
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
export function sortTasks(tasks, today = istToday(), order = 'recommended') {
  const rank = (t) => [
    CLOSED.has(t.status) ? 1 : 0,          // done and cancelled sink
    isOverdue(t, today) ? 0 : 1,           // late work floats
    -(PRIORITY_RANK[t.priority] ?? 0),     // urgent before low
    t.due_date || '9999-12-31',            // soonest deadline; undated last
  ];
  return [...(tasks ?? [])].sort((a, b) => {
    // Display sorting applies to the entire filtered set before pagination. Keep closed work at
    // the end for due-date and priority views; newest/title are literal across all visible tasks.
    if (order === 'newest') return String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
    if (order === 'title') return String(a.title ?? '').localeCompare(String(b.title ?? ''), 'en', { sensitivity: 'base', numeric: true });
    if (order === 'due' || order === 'priority') {
      const closed = Number(CLOSED.has(a.status)) - Number(CLOSED.has(b.status));
      if (closed) return closed;
      const chosen = order === 'due'
        ? (a.due_date || '9999-12-31').localeCompare(b.due_date || '9999-12-31')
        : (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0);
      if (chosen) return chosen;
    }
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
export function filterTasks(tasks, { mineOnly = false, myEmployeeId = null, personId = null, statusFilter = 'Active', query = '', today = istToday() } = {}) {
  // Ownership first, then the free text — both are plain row predicates, so the order does not
  // change the answer; it is written this way to make the guarantee obvious. What matters is that
  // the query only ever REMOVES rows from a list RLS and mine-only have already settled. Search
  // that reaches the database instead would be a different, and much easier, thing to get wrong.
  //
  // `personId` is the board's "Everyone / <name>" filter — what the By Person view used to answer,
  // as a narrowing of one list rather than a second way of drawing it.
  const scoped = searchTasks(
    (tasks ?? []).filter((t) => {
      if (mineOnly && !isAssignedTo(t, myEmployeeId)) return false;
      if (personId && !isAssignedTo(t, personId)) return false;
      return true;
    }),
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
export function taskStats(tasks, { mineOnly = false, myEmployeeId = null, personId = null, query = '', today = istToday() } = {}) {
  // The counts describe the corpus the chips act ON — so they follow mine-only, the person filter
  // and the search box, but not the status chip itself, which is what they are there to select.
  // Leaving any of the three out would put "Total 47" next to two results.
  const scope = searchTasks(
    (tasks ?? []).filter((t) => {
      if (mineOnly && !isAssignedTo(t, myEmployeeId)) return false;
      if (personId && !isAssignedTo(t, personId)) return false;
      return true;
    }),
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

/*
 * buildTaskTree, groupByPerson, loopMembers and rootContaining lived here until 0114.
 *
 * They existed to serve two views: Flow drew tasks as a parent/child tree, By Person grouped them
 * by assignee. Both are gone. The tree earned nothing — seven tasks in production, one of them
 * nested — and it was the FIRST screen a manager saw, so the least useful view was also the most
 * seen one. By Person is now a filter on the single board (`personId` in filterTasks), which
 * answers the same question without being a second way of drawing the same rows.
 *
 * A task's steps are checklist items now, not sub-tasks, so nothing nests and nothing can loop.
 */

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
  return `new:${composer.defaultAssignee ?? ''}`;
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
