export const ACTIONABLE_NOTIFICATION_STATUSES = {
  leave: new Set(['Pending', 'On Hold']),
  expense: new Set(['Pending']),
  regularization: new Set(['Pending']),
  task: new Set(['To Do', 'In Progress', 'Blocked']),
  ticket: new Set(['Open', 'In Progress', 'On Hold']),
  // A help request needs an answer only while it is Pending; once accepted, declined or
  // withdrawn it is news rather than a thing to do.
  help: new Set(['Pending']),
};

export function filterActionableNotifications(notifications, refStatuses = {}) {
  return (notifications ?? []).filter((n) => {
    if (n.read_at) return false;

    const actionableStatuses = ACTIONABLE_NOTIFICATION_STATUSES[n.type];
    if (!actionableStatuses || !n.ref_id) return true;

    // When a type is absent the status query has not loaded yet, so keep the notification visible
    // rather than flickering it away. Once the type is present, a missing row means the referenced
    // item was deleted or is no longer visible/actionable.
    if (!Object.prototype.hasOwnProperty.call(refStatuses, n.type)) return true;
    const status = refStatuses[n.type]?.[n.ref_id];
    if (!status) return false;
    return actionableStatuses.has(status);
  });
}

/**
 * Collapse identical unread notifications into one row, for the dashboard's "Needs attention" strip.
 *
 * Three people filing leave produce three "New leave request" rows that say the same thing and go
 * to the same screen; the strip shows one with a count of 3.
 *
 * `ids` is the whole group, and it is the point. The version this replaces spread the FIRST member
 * (`{ ...n, count }`) and kept only that one id, so the row rendered a badge saying 3 while
 * carrying a single notification. Anything acting on the row — marking it read, above all — would
 * have silently dealt with one of the three and left the other two unread forever.
 *
 * Lives here rather than in shared.jsx so it can be tested: that file imports React and the data
 * hooks, which the test runner cannot load.
 */
export function groupUnreadNotifications(notifications) {
  const groups = new Map();
  for (const n of notifications ?? []) {
    if (n.read_at) continue;
    const key = [n.type || 'notification', n.tab || '', n.title || 'Notification'].join('|');
    const group = groups.get(key);
    if (group) {
      group.count += 1;
      group.ids.push(n.id);
      continue;
    }
    groups.set(key, { ...n, count: 1, ids: [n.id] });
  }
  return [...groups.values()];
}

/**
 * Which notification ids an "open" gesture should mark read.
 *
 * One rule, because there are three surfaces drawing these things — the bell dropdown, the
 * notifications screen and the dashboard strip — and the strip had drifted into being a plain
 * navigation control that never marked anything. Grouped rows carry every id they stand for;
 * a single row contributes itself only if it is still unread.
 */
export function idsToMarkRead(n) {
  if (!n) return [];
  if (Array.isArray(n.ids)) return n.ids;
  return n.read_at ? [] : [n.id];
}
