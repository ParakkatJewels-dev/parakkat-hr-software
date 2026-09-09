// What the sidebar offers, and to whom.
//
// This used to live inline in App.jsx, which was fine while the sidebar was the only thing that
// needed it. It is not any more: Administration now answers "what does this person actually see?"
// for a chosen user, and a second copy of the tree would drift from the real one within a release
// — the same failure the Payroll tab whitelist had, where two hand-written lists disagreed and
// three of four tabs bounced back to Payslips.
//
// One definition, two readers. App.jsx renders it for the signed-in user; the access inspector
// evaluates it against somebody else's permissions. Because the second reader passes a plain
// permission list rather than a hook, the rules below take predicates as arguments instead of
// calling usePermissions themselves.
//
// NOT A SECURITY BOUNDARY. This decides what is offered, never what is reachable — App.jsx's route
// guard re-checks real permissions, and RLS answers to the signed-in user regardless. A bug here
// shows the wrong menu, not the wrong data.

/**
 * The self-service tree, shown to somebody whose most senior role is `employee`.
 * Flat on purpose: with a set this small, a second level is friction.
 */
export const ESS_NAV = [
  {
    title: 'My Workspace',
    items: [
      { id: 'dashboard', label: 'Dashboard', perm: null },
      { id: 'attendance', label: 'My Attendance', perm: 'attendance.read' },
      { id: 'leave', label: 'My Leave', perm: 'leave.read' },
      { id: 'payroll', label: 'My Payslips', perm: 'payslip.read' },
      { id: 'tasks', label: 'My Tasks', perm: 'task.read' },
      { id: 'performance', label: 'My Goals', perm: 'goal.read' },
      { id: 'expense', label: 'My Expenses', perm: 'expense.read' },
      { id: 'my-assets', label: 'My Assets', perm: 'asset.read' },
      { id: 'documents', label: 'My Documents', perm: 'document.read' },
    ],
  },
  {
    title: 'Support',
    items: [
      { id: 'helpdesk', label: 'Help & Support', perm: 'ticket.read' },
      { id: 'profile', label: 'My Profile', perm: null },
      { id: 'notifications', label: 'Notifications', perm: null },
      { id: 'settings', label: 'Settings', perm: null },
    ],
  },
];

/**
 * The oversight tree: eight destinations, each grouping the screens that belong to one job.
 *
 * `scoped: true` means the permission must be held BEYOND self scope. Every manager also holds a
 * self grant (0096), so without this a screen like the Directory would open for a plain employee
 * carrying self-scoped employee.read.
 *
 * `selfLabel` is the name the screen takes when the viewer holds the permission at self scope only
 * — Payroll and Documents serve two audiences, and someone arriving at a screen headed "Payroll"
 * containing one payslip reasonably concludes the module is broken.
 */
export const OVERSIGHT_NAV = [
  {
    id: 'home',
    label: 'Home',
    tabs: [{ id: 'dashboard', label: 'Dashboard', perm: null }],
  },
  {
    id: 'people',
    label: 'People',
    tabs: [
      { id: 'team', label: 'My Team', perm: 'employee.assign' },
      { id: 'directory', label: 'Directory', perm: 'employee.read', scoped: true },
      { id: 'employee-import', label: 'Import', perm: 'employee.create' },
      { id: 'organization', label: 'Structure', perm: 'org.manage' },
      { id: 'recruitment', label: 'Hiring', perm: 'recruitment.manage' },
      { id: 'onboarding', label: 'Onboarding', perm: 'onboarding.manage' },
      { id: 'documents', label: 'Documents', selfLabel: 'My Documents', perm: 'document.read' },
    ],
  },
  {
    id: 'time',
    label: 'Time & Attendance',
    tabs: [
      { id: 'attendance', label: 'Attendance', perm: 'attendance.read' },
      { id: 'attendance-person', label: 'By person', perm: 'attendance.read', scoped: true },
      { id: 'leave', label: 'Leave', perm: 'leave.read' },
      { id: 'attendance-admin', label: 'Shifts & Devices', perm: 'device.manage' },
    ],
  },
  {
    id: 'pay',
    label: 'Pay & Expenses',
    tabs: [
      { id: 'payroll', label: 'Payroll', selfLabel: 'My Payslips', perm: 'payslip.read' },
      { id: 'expense', label: 'Expenses', perm: 'expense.read' },
    ],
  },
  {
    id: 'asset-management',
    label: 'Asset Management',
    tabs: [{ id: 'assets', label: 'Assets', perm: 'asset.read', scoped: true }],
  },
  {
    id: 'work',
    label: 'Work',
    tabs: [
      { id: 'tasks', label: 'Tasks', perm: 'task.read' },
      { id: 'performance', label: 'Goals', perm: 'goal.read' },
    ],
  },
  {
    id: 'support',
    label: 'Support',
    tabs: [{ id: 'helpdesk', label: 'Helpdesk & Exits', perm: 'ticket.read' }],
  },
  {
    id: 'insights',
    label: 'Reports',
    tabs: [{ id: 'reports', label: 'Reports', perm: 'report.read' }],
  },
  {
    id: 'account',
    label: 'My Profile',
    tabs: [
      { id: 'profile', label: 'Profile', perm: null },
      { id: 'notifications', label: 'Notifications', perm: null },
      { id: 'settings', label: 'Settings', perm: null },
    ],
  },
  {
    id: 'admin',
    label: 'Administration',
    tabs: [
      { id: 'administration', label: 'Users & Access', perm: 'rbac.manage' },
      { id: 'admin-roles', label: 'Roles', perm: 'rbac.manage' },
      // audit.read, not rbac.manage: the audit_log policy requires audit.read, which only
      // entity_admin and super_admin hold. Gating on rbac.manage handed the tab to four more
      // roles, all of whom then saw a permanently empty screen.
      { id: 'admin-audit', label: 'Audit Log', perm: 'audit.read' },
    ],
  },
];

/**
 * Can this viewer see one tab? `scoped` tabs need the permission beyond self scope.
 *
 * `hidden` is the per-user override list (migration 0109) — screens an administrator has taken out
 * of this one person's sidebar on top of their role. It narrows and never widens, so it is applied
 * last and can only turn a true into a false.
 *
 * Applied here rather than only where the menu is drawn, so the route guard turns away a hidden
 * screen typed into the URL too. That still is not a security boundary: the permission is
 * untouched and the database will serve the data to anything that asks. It is "not part of your
 * job", not "you may not have this".
 */
export function canSeeTab(tab, { canAny, canBeyondSelf, hidden }) {
  // Accepts a Set (what predicatesFor builds) or a plain array (what a caller may hand over).
  const isHidden = hidden instanceof Set ? hidden.has(tab.id) : (hidden ?? []).includes(tab.id);
  if (isHidden) return false;
  if (!tab.perm) return true;
  return tab.scoped ? canBeyondSelf(tab.perm) : canAny(tab.perm);
}

/** The name a tab takes for this viewer — see `selfLabel`. */
export function labelForTab(tab, { canBeyondSelf }) {
  if (!tab.selfLabel) return tab.label;
  return canBeyondSelf(tab.perm) ? tab.label : tab.selfLabel;
}

/**
 * The tree this viewer actually gets: their sections, each carrying only their permitted tabs,
 * with any section left empty dropped entirely.
 *
 * `primaryRole` picks the tree — 'employee' gets the self-service one. Pass the ESS sections
 * already flattened by the caller, or let this do it: both trees use the same tab shape, so a
 * screen id resolves identically whichever tree produced it.
 */
export function visibleSections(primaryRole, predicates) {
  const sections =
    primaryRole === 'employee'
      ? ESS_NAV.flatMap((group) =>
          group.items.map((item) => ({ id: item.id, label: item.label, tabs: [item] }))
        )
      : OVERSIGHT_NAV;

  return sections
    .map((section) => ({
      ...section,
      tabs: section.tabs
        .filter((tab) => canSeeTab(tab, predicates))
        .map((tab) => ({ ...tab, label: labelForTab(tab, predicates) })),
    }))
    .filter((section) => section.tabs.length > 0);
}

/** Every screen id the application defines, in either tree — for route validation. */
export function allScreenIds() {
  const ids = new Set();
  for (const group of ESS_NAV) for (const item of group.items) ids.add(item.id);
  for (const section of OVERSIGHT_NAV) for (const tab of section.tabs) ids.add(tab.id);
  return [...ids];
}

/**
 * Predicates built from a plain permission list rather than the signed-in session.
 *
 * This is what lets the access inspector ask the questions above about SOMEBODY ELSE. The shapes
 * match usePermissions' canAny / canBeyondSelf exactly, so the inspector and the sidebar cannot
 * disagree about what a permission set means.
 */
export function predicatesFor(permissions, { isSuperAdmin = false, hiddenScreens = [] } = {}) {
  const list = permissions ?? [];
  // A super admin is never narrowed — matching 0109's trigger and its get_my_access branch. The
  // account that can undo an override must not be the one locked out by it.
  const hidden = new Set(isSuperAdmin ? [] : hiddenScreens ?? []);
  return {
    canAny: (perm) => isSuperAdmin || list.some((p) => p.permission === perm),
    canBeyondSelf: (perm) =>
      isSuperAdmin || list.some((p) => p.permission === perm && p.scope_type !== 'self'),
    hidden,
  };
}
