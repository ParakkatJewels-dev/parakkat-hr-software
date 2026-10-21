import { allScreenIds } from './navMap.js';

// These are route shapes, not permission grants. Each screen still checks which of its tabs the
// current user may open; for example a self reader keeps Payroll's existing payslip fallback.
export const APP_TAB_PATHS = {
  attendance: ['today', 'person', 'calendar', 'overview', 'exceptions', 'regularizations'],
  'attendance-admin': ['mapping', 'shifts', 'holidays', 'leaveTypes', 'sync'],
  payroll: ['run', 'history', 'payslips', 'salary', 'components'],
  documents: ['employee', 'company'],
  performance: ['mine', 'team'],
  tasks: ['board', 'todo', 'requests', 'routine', 'deleted'],
  ledger: ['home', 'team', 'requests', 'routines', 'reports', 'insights', 'campaigns', 'ideas', 'library', 'deleted', 'settings'],
  reports: ['attendance', 'leave', 'expenses', 'headcount'],
};

// Keep existing bookmarks for views folded into the current workflows.
export const LEGACY_TAB_PATHS = { tasks: ['flow', 'people'], payroll: ['worksheet'] };
export const DETAIL_SCREENS = ['directory', 'assets'];
export const DETAIL_ID_PATTERN = '[A-Za-z0-9_-]+';
const DETAIL_ID = new RegExp(`^${DETAIL_ID_PATTERN}$`);
const SCREENS = new Set(allScreenIds());

/** Validate the complete pathname before a lazy page mounts or starts its data queries. */
export function resolveAppRoute(pathname) {
  const parts = String(pathname ?? '').split('/').filter(Boolean);
  const screen = parts[0] || 'dashboard';
  const knownScreen = SCREENS.has(screen);
  const valid = knownScreen && (parts.length < 2 || (parts.length === 2 && (
    APP_TAB_PATHS[screen]?.includes(parts[1]) || LEGACY_TAB_PATHS[screen]?.includes(parts[1])
      || (DETAIL_SCREENS.includes(screen) && DETAIL_ID.test(parts[1]))
  )));
  return { screen, knownScreen, valid: Boolean(valid) };
}

/**
 * The Work Ledger replaced Task Management (0173). Old links, bookmarks, notifications and the
 * dashboard still say /tasks/<view>; send each to the Ledger tab that holds the same view, keeping
 * any ?focus= or ?routineView=. Returns null for anything that is not a Task Management address.
 */
export function tasksToLedger(pathname, search = '', { canTeam = false } = {}) {
  const parts = String(pathname ?? '').split('/').filter(Boolean);
  if (parts[0] !== 'tasks') return null;
  const view = parts[1] ?? '';
  const tab = { todo: 'home', requests: 'requests', routine: 'routines', deleted: 'deleted' }[view]
    ?? (canTeam ? 'team' : 'home');
  return `/ledger/${tab}${search ?? ''}`;
}

/** Unknown screens are 404s; known screens still respect their original access guard first. */
export function appRouteDisposition(route, allowed) {
  if (!route.knownScreen) return 'not-found';
  if (!allowed) return 'access-denied';
  return route.valid ? 'page' : 'not-found';
}
