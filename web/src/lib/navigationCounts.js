export const NAVIGATION_COUNT_LABELS = {
  tasks: ['task to complete', 'tasks to complete'],
  leave: ['leave request to review', 'leave requests to review'],
  expense: ['expense to review', 'expenses to review'],
  attendance: ['attendance request to review', 'attendance requests to review'],
  helpdesk: ['unresolved ticket', 'unresolved tickets'],
};

export function validNavigationCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function navigationScreenCount(id, counts, unreadMessageCount) {
  if (id === 'messages') return {
    count: validNavigationCount(unreadMessageCount), singular: 'unread message', plural: 'unread messages', unread: true,
  };
  const labels = NAVIGATION_COUNT_LABELS[id];
  return labels ? { count: validNavigationCount(counts?.[id]), singular: labels[0], plural: labels[1] } : null;
}

/** Aggregate the permitted tabs supplied by the caller, never the complete navigation catalog. */
export function navigationSectionCount(section, counts, unreadMessageCount) {
  const tabs = [...new Map((section.tabs ?? []).map(tab => [tab.id, tab])).values()];
  const badges = tabs.map(tab => navigationScreenCount(tab.id, counts, unreadMessageCount)).filter(Boolean);
  if (!badges.length) return null;
  if (tabs.length === 1) return badges[0];
  return {
    // A partial sum looks exact but understates the total; leave it unknown until all parts load.
    count: badges.every(badge => badge.count !== null) ? badges.reduce((sum, badge) => sum + badge.count, 0) : null,
    singular: 'item needing action', plural: 'items needing action',
  };
}

export function navigationCountLabel(label, badge) {
  return badge?.count > 0 ? `${label}, ${badge.count} ${badge.count === 1 ? badge.singular : badge.plural}` : label;
}

export function navigationCountTarget(tab, counts) {
  return tab.id === 'helpdesk' && validNavigationCount(counts?.helpdesk) > 0
    ? 'helpdesk?ticketQueue=needs-action' : tab.to ?? tab.id;
}
