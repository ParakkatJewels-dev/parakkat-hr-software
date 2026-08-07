export const ACTIONABLE_NOTIFICATION_STATUSES = {
  leave: new Set(['Pending', 'On Hold']),
  expense: new Set(['Pending']),
  regularization: new Set(['Pending']),
  task: new Set(['To Do', 'In Progress', 'Blocked']),
  ticket: new Set(['Open', 'In Progress', 'On Hold']),
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
