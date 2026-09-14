// The daily routine: what somebody does every day, and whether they have done it today.
//
// Pure, so it can be tested — the screen reaches Supabase through its hooks and the test runner
// cannot load it. Same split as taskBoard.js beside it.

/**
 * One person's list for a day: their active duties, each carrying whether it is ticked.
 *
 * `ticks` is every tick loaded for the day, not just this person's, because the head's board loads
 * the whole team in one query and then slices it here rather than per person.
 */
export function routineForDay(items, ticks, employeeId, onDate) {
  const done = new Set(
    (ticks ?? [])
      .filter((t) => t.on_date === onDate && (!employeeId || t.employee_id === employeeId))
      .map((t) => t.routine_item_id)
  );
  return (items ?? [])
    .filter((i) => i.is_active !== false && (!employeeId || i.employee_id === employeeId))
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.title).localeCompare(String(b.title)))
    .map((i) => ({ ...i, done: done.has(i.id) }));
}

/** done / total for a list produced by routineForDay. */
export function routineProgress(list) {
  const total = (list ?? []).length;
  const done = (list ?? []).filter((i) => i.done).length;
  return { done, total, complete: total > 0 && done === total, pct: total ? Math.round((done / total) * 100) : 0 };
}

/**
 * The head's view: one row per person who has a routine, with today's progress.
 *
 * Sorted so the people who still owe something come first — a completion board is read to find who
 * has NOT finished, and putting the finished ones at the top makes you scroll past the answer.
 * Within that, the furthest behind first, then by name so the order is stable day to day.
 */
export function teamRoutineSummary(items, ticks, onDate) {
  const byEmployee = new Map();
  for (const item of items ?? []) {
    if (item.is_active === false) continue;
    if (!byEmployee.has(item.employee_id)) {
      byEmployee.set(item.employee_id, { employeeId: item.employee_id, employee: item.employee ?? null, items: [] });
    }
    byEmployee.get(item.employee_id).items.push(item);
  }

  return [...byEmployee.values()]
    .map((group) => {
      const list = routineForDay(group.items, ticks, group.employeeId, onDate);
      return { ...group, list, ...routineProgress(list) };
    })
    .sort((a, b) => {
      if (a.complete !== b.complete) return a.complete ? 1 : -1;
      if (a.pct !== b.pct) return a.pct - b.pct;
      return (a.employee?.full_name || '').localeCompare(b.employee?.full_name || '');
    });
}

/**
 * Narrow the head's board: find one person, or show only who still owes something.
 *
 * Filters the SUMMARY and never the duties inside it. Filtering the items first would be the
 * obvious implementation and quietly wrong: somebody with three duties who has done one would show
 * a card reading "1 of 1", because the two ticked-off lines were removed before the counting. A
 * person's progress has to describe their whole day or it describes nothing.
 *
 * Words, not a phrase, and every word must match — same rule as searchTasks in taskBoard.js, so
 * "anand p021" narrows rather than widens and the two boards behave the same way under the same
 * typing. Name and code only: routine_items embeds nothing else about a person.
 *
 * This searches a LIST that RLS has already settled, and can only ever remove rows from it. A
 * search must never be the thing that decides who sees what, and this one structurally cannot be.
 */
export function filterTeamRoutine(groups, { query = '', status = 'all' } = {}) {
  const terms = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return (groups ?? []).filter((group) => {
    if (status === 'owing' && group.complete) return false;
    if (status === 'finished' && !group.complete) return false;
    if (terms.length === 0) return true;
    const hay = [group.employee?.full_name, group.employee?.employee_code]
      .filter(Boolean).join(' \u0000 ').toLowerCase();
    return terms.every((term) => hay.includes(term));
  });
}

/** How many people on the board still owe something — the number worth putting on the filter. */
export function stillOwing(groups) {
  return (groups ?? []).filter((g) => !g.complete).length;
}
