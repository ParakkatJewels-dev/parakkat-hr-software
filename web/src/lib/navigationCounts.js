export const NAVIGATION_COUNT_LABELS = {
  tasks: ['task to complete', 'tasks to complete'],
  leave: ['leave request to review', 'leave requests to review'],
  expense: ['expense to review', 'expenses to review'],
  attendance: ['attendance request to review', 'attendance requests to review'],
  helpdesk: ['unresolved ticket', 'unresolved tickets'],
  performance: ['active goal', 'active goals'],
  payroll: ['draft payroll run', 'draft payroll runs'],
  onboarding: ['onboarding checklist to finish', 'onboarding checklists to finish'],
  recruitment: ['candidate in progress', 'candidates in progress'],
  'attendance-admin': ['device employee to link', 'device employees to link'],
  notifications: ['unread notification', 'unread notifications'],
};

// Each queue has one source. Parent badges sum distinct queues, never another parent total.
const QUEUES = {
  'tasks/todo': ['tasks', ...NAVIGATION_COUNT_LABELS.tasks],
  'tasks/requests': ['task_requests', 'request to review', 'requests to review'],
  'tasks/routine': ['task_routine', 'routine job to complete today', 'routine jobs to complete today'],
  'attendance/regularizations': ['attendance', ...NAVIGATION_COUNT_LABELS.attendance],
  'attendance-admin/mapping': ['attendance_mapping', ...NAVIGATION_COUNT_LABELS['attendance-admin']],
  'performance/mine': ['performance_mine', ...NAVIGATION_COUNT_LABELS.performance],
  'performance/team': ['performance_team', ...NAVIGATION_COUNT_LABELS.performance],
  'payroll/run': ['payroll', ...NAVIGATION_COUNT_LABELS.payroll],
  'helpdesk/tickets': ['helpdesk', ...NAVIGATION_COUNT_LABELS.helpdesk],
  'helpdesk/exits': ['exits', 'exit clearance to review', 'exit clearances to review'],
};
const SOURCES = {
  tasks: ['tasks', 'task_requests', 'task_routine'],
  helpdesk: ['helpdesk', 'exits'],
  performance: ['performance_mine', 'performance_team'],
  'attendance-admin': ['attendance_mapping'],
};

export const NAVIGATION_COUNT_KEYS = [...new Set([
  'tasks', 'leave', 'expense', 'attendance', 'helpdesk', 'payroll', 'onboarding', 'recruitment', 'notifications',
  ...Object.values(SOURCES).flat(),
])];

export function validNavigationCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function navigationScreenCount(id, counts, unreadMessageCount) {
  if (id === 'messages') return {
    count: validNavigationCount(unreadMessageCount), singular: 'unread message', plural: 'unread messages', unread: true,
  };
  const queue = QUEUES[id];
  if (queue) return { count: validNavigationCount(counts?.[queue[0]]), singular: queue[1], plural: queue[2] };
  const labels = NAVIGATION_COUNT_LABELS[id];
  if (!labels) return null;
  const keys = SOURCES[id] ?? [id];
  // Never present a partial total as exact: every contributing queue must be known.
  const values = keys.map(key => validNavigationCount(counts?.[key]));
  const aggregate = id === 'tasks' ? counts?.task_requests > 0 || counts?.task_routine > 0
    : id === 'helpdesk' && counts?.exits > 0;
  return {
    count: values.every(value => value !== null) ? values.reduce((sum, value) => sum + value, 0) : null,
    singular: aggregate ? 'item needing action' : labels[0],
    plural: aggregate ? 'items needing action' : labels[1],
  };
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
