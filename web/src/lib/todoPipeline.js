// One person's own board, and how far along it is.
//
// The task board answers "what is outstanding across my team". This answers the smaller and more
// frequent question — what is on MY plate today, and what moves next — which people were trying to
// use the team board for and finding the wrong shape: it is grouped by person when there is only
// one person, and it leads with a delegation tree when nothing here is delegated.
//
// Pure, so it can be tested. The screen imports Supabase through its hooks and cannot be.

import { isOverdue } from './taskBoard.js';

/**
 * The stages work actually moves through, in order.
 *
 * Cancelled is deliberately absent: it is not a stage on the way to anywhere, it is a decision to
 * stop, and putting it in the pipeline would suggest otherwise. Cancelled items are still listed —
 * see `closedItems` — they just do not count towards progress.
 */
export const PIPELINE = ['To Do', 'In Progress', 'Blocked', 'Done'];

/** Where a stage sits, or -1 for one that is not on the pipeline (Cancelled). */
export const stageIndex = (status) => PIPELINE.indexOf(status);

/**
 * The next status a one-tap advance should set.
 *
 * Blocked does not advance to Done — being blocked is a state you leave by getting unblocked, so
 * the useful move from there is back to In Progress. Done and Cancelled do not advance at all.
 */
export function nextStage(status) {
  switch (status) {
    case 'To Do': return 'In Progress';
    case 'In Progress': return 'Done';
    case 'Blocked': return 'In Progress';
    default: return null;
  }
}

/** The word on the button that performs `nextStage`. */
export function advanceLabel(status) {
  switch (status) {
    case 'To Do': return 'Start';
    case 'In Progress': return 'Done';
    case 'Blocked': return 'Unblock';
    default: return null;
  }
}

/**
 * Everything on this person's board, split into what is live and what is finished.
 *
 * `mine` is the employee id. A task counts as theirs when it is assigned to them, whoever put it
 * there — the personal list is "my plate", not "things I set myself", because a job your head gave
 * you is on your plate too and leaving it out would make the count a lie.
 */
export function myBoard(tasks = [], mine, { today } = {}) {
  const rows = (tasks ?? []).filter((t) => t && t.employee_id === mine);
  const open = rows.filter((t) => t.status !== 'Done' && t.status !== 'Cancelled');
  const closed = rows.filter((t) => t.status === 'Done' || t.status === 'Cancelled');

  return {
    open: sortForMe(open, today),
    closed: closed.slice().sort(byNewestClose),
    all: rows,
  };
}

/**
 * Overdue first, then by due date, then by priority.
 *
 * The team board sorts by structure because it is a tree. A personal list has no structure, so it
 * sorts by urgency — the only ordering that answers "what do I do next".
 */
const PRIORITY_RANK = { Urgent: 0, High: 1, Medium: 2, Low: 3 };

export function sortForMe(rows = [], today) {
  return rows.slice().sort((a, b) => {
    const ao = isOverdue(a, today) ? 0 : 1;
    const bo = isOverdue(b, today) ? 0 : 1;
    if (ao !== bo) return ao - bo;

    const ad = a.due_date || '9999-12-31';
    const bd = b.due_date || '9999-12-31';
    if (ad !== bd) return ad < bd ? -1 : 1;

    const ap = PRIORITY_RANK[a.priority] ?? 9;
    const bp = PRIORITY_RANK[b.priority] ?? 9;
    if (ap !== bp) return ap - bp;

    return (a.title || '').localeCompare(b.title || '');
  });
}

const byNewestClose = (a, b) =>
  String(b.completed_at || b.created_at || '').localeCompare(String(a.completed_at || a.created_at || ''));

/**
 * How far along the whole board is.
 *
 * `percent` counts Done against everything that is not Cancelled — a cancelled item is not
 * progress and not a debt either, so it leaves the sum entirely. A board of nothing but cancelled
 * items reads 0% of 0 rather than 100%, which would be a strange way to say "you did nothing".
 */
export function progress(tasks = [], mine, { today } = {}) {
  const rows = (tasks ?? []).filter((t) => t && t.employee_id === mine);
  const counted = rows.filter((t) => t.status !== 'Cancelled');
  const byStage = {};
  for (const stage of PIPELINE) byStage[stage] = 0;
  for (const t of counted) {
    if (byStage[t.status] !== undefined) byStage[t.status] += 1;
  }

  const done = byStage.Done;
  const total = counted.length;

  return {
    byStage,
    total,
    done,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    overdue: counted.filter((t) => t.status !== 'Done' && isOverdue(t, today)).length,
    // What is actually in front of them right now — the number worth putting in a badge.
    open: total - done,
  };
}

/**
 * Did this person put this on their own list?
 *
 * Drives whether Delete is offered: 0113 lets you remove work you set yourself and not work
 * somebody gave you, and offering a button the database will refuse is worse than not offering it.
 */
export function isSelfSet(task, mine) {
  return Boolean(task) && task.employee_id === mine && task.assigned_by === mine;
}
