// What is left inside one task, and what that means for the task itself.
//
// A checklist item is done exactly when `completed_by` and `completed_at` are BOTH set — the
// database has a check constraint saying so (0114), because half a tick is not a state any screen
// should have to interpret. `completed_by` is the whole point of the feature: the line shows who
// ticked it, not merely that somebody did.
//
// Pure, so it can be tested. The screen reaches Supabase through its hooks and cannot be.

/** Done means somebody put their name to it. */
export const isItemDone = (item) => Boolean(item?.completed_at && item?.completed_by);

/**
 * Reading order: `position` first, then oldest-first as the tie-break.
 *
 * `position` is not unique and is never renumbered, so two items CAN share one — delete from the
 * middle and add again and the gap is simply never reused. created_at is stable and always
 * present, so the tie-break makes the order total and the list cannot appear to shuffle between
 * renders.
 */
export function sortItems(items = []) {
  return [...(items ?? [])].sort((a, b) => {
    const pa = a?.position ?? 0;
    const pb = b?.position ?? 0;
    if (pa !== pb) return pa - pb;
    return String(a?.created_at ?? '').localeCompare(String(b?.created_at ?? ''));
  });
}

/** The "2 of 3" on the card, and the bar under it. */
export function checklistProgress(items = []) {
  const rows = items ?? [];
  const total = rows.length;
  const done = rows.filter(isItemDone).length;
  return {
    total,
    done,
    // 0 of 0 is 0%, not 100%. An empty checklist has not been completed, it does not exist.
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    allDone: total > 0 && done === total,
  };
}

/**
 * The status this task should have, given its checklist — or null to leave it alone.
 *
 * This MIRRORS app.tg_task_checklist_rollup (migration 0114) branch for branch. The database is
 * the authority; this exists so the screen can show the outcome on the tap rather than after the
 * round trip, and so the rule is testable without a database. If the two ever disagree, the
 * database wins and this is the bug.
 *
 * The four branches, and why each is what it is:
 *
 *   * No items at all — untouched. Most tasks are one thing with no steps, and those stay entirely
 *     hand-driven. Auto-completion only applies once somebody has actually written a list.
 *   * Cancelled — untouched, in either direction. Cancelled is a decision to stop, not a stage on
 *     the way to anywhere, so no amount of ticking should reopen or complete it.
 *   * All ticked — Done. This is the feature that was asked for.
 *   * Not all ticked but the task says Done — back to In Progress. The reverse of the rule above,
 *     and it has to hold: if the checklist decides, then adding a line to a finished task reopens
 *     it and unticking a line reopens it. In Progress rather than To Do, because some of it
 *     demonstrably happened.
 */
export function statusFromChecklist(task, items = []) {
  const { total, allDone } = checklistProgress(items);
  const status = task?.status;

  if (total === 0 || !status || status === 'Cancelled') return null;
  if (allDone && status !== 'Done') return 'Done';
  if (!allDone && status === 'Done') return 'In Progress';
  return null;
}

/**
 * Where a newly added line goes: the end.
 *
 * Positions are not renumbered on every insert — that would be a write per row for a cosmetic
 * gain — so this is max + 1 rather than length, which stays correct after a delete from the middle.
 */
export function nextPosition(items = []) {
  const rows = items ?? [];
  if (rows.length === 0) return 0;
  return Math.max(...rows.map((i) => i?.position ?? 0)) + 1;
}

/**
 * Who ticked this, for the line under the item.
 *
 * Returns null for an item nobody has ticked. `employee` is an embedded read, so it can be null
 * for a viewer who cannot see that person's row even though the tick itself is real — the name
 * falls back rather than the whole line disappearing.
 */
export function tickedBy(item, { unknownLabel = 'Someone' } = {}) {
  if (!isItemDone(item)) return null;
  return {
    name: item.completer?.full_name || unknownLabel,
    employeeId: item.completed_by,
    at: item.completed_at,
  };
}

/**
 * Who this step is FOR — the name on it BEFORE the work (0130).
 *
 * The counterpart to tickedBy, and deliberately a different column: `assigned_to` is the intention,
 * `completed_by` is the record. They usually agree and the interesting cases are when they do not.
 *
 * Null for a step nobody is named on, which is most of them: a line anyone on the task can pick up
 * is a perfectly good line. Same embedded-read caveat as tickedBy — the name falls back rather than
 * the ownership silently disappearing for a viewer who cannot read that employee row.
 */
export function ownerOf(item, { unknownLabel = 'Someone' } = {}) {
  if (!item?.assigned_to) return null;
  return {
    name: item.owner?.full_name || unknownLabel,
    employeeId: item.assigned_to,
    code: item.owner?.employee_code ?? null,
  };
}

/**
 * May this person tick this line?
 *
 * MIRRORS app.tg_checklist_tick_guard (0130) branch for branch, the same way statusFromChecklist
 * mirrors the rollup trigger. The database is the authority; this exists so the screen can grey out
 * a checkbox instead of offering one that fails, and so the rule is testable without a database.
 *
 *   * A step with an owner is that person's alone — a manager on the task cannot tick it for them.
 *     Ticking writes a name into completed_by, and that name should never be a polite fiction.
 *   * A step with no owner keeps 0114's rule exactly: anybody on the task may tick it.
 *
 * `onTask` is whether this person is one of the task's assignees — isAssignedTo in taskBoard.js,
 * which the caller has already worked out for the task as a whole.
 *
 * Note what this does NOT decide: whether the owner can be CHANGED. Anyone who may edit the task
 * may reassign a line or clear its owner, which is the escape hatch for a step owned by somebody on
 * leave. Reassigning is visible on the row; ticking on somebody's behalf would not be.
 */
export function canTickItem(item, employeeId, { onTask = false } = {}) {
  if (!employeeId) return false;
  const owner = item?.assigned_to ?? null;
  return owner ? owner === employeeId : Boolean(onTask);
}
