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
