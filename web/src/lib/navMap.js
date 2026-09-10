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
 *
 * Ordered by what somebody actually opens this on a phone to DO, which is not the order it used to
 * be in. Attendance, Leave and Payslips led the tree, so those were the four things the bottom bar
 * offered (see MOBILE_PRIMARY_IDS) and Tasks — the screen an employee touches several times a day
 * — was behind More, two taps and a scroll away. Pay is opened once a month and had a permanent
 * seat; work had none.
 *
 * The groups are titles the phone drawer prints, so they have to read as a map of the app rather
 * than as internal vocabulary: what you do, what is yours, and where to get help.
 */
export const ESS_NAV = [
  {
    title: 'Work',
    items: [
      { id: 'dashboard', label: 'Dashboard', perm: null },
      { id: 'tasks', label: 'My Tasks', perm: 'task.read' },
      // No permission: everybody can talk to everybody. A directory that will not let one branch
      // message another is a directory people work around rather than use (0115).
      { id: 'messages', label: 'Messages', perm: null, needsEmployee: true },
      { id: 'attendance', label: 'My Attendance', perm: 'attendance.read' },
      { id: 'performance', label: 'My Goals', perm: 'goal.read' },
    ],
  },
  {
    title: 'Me',
    items: [
      { id: 'leave', label: 'My Leave', perm: 'leave.read' },
      { id: 'payroll', label: 'My Payslips', perm: 'payslip.read' },
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
  // Second, not sixth. This is the section a manager opens between meetings; People and Pay are
  // where they go when they sit down. Sixth also put it off the phone's bottom bar entirely, back
  // when that bar was the first four sections of this list — see MOBILE_PRIMARY_IDS, which now
  // names its four rather than inheriting them.
  {
    id: 'work',
    label: 'Work',
    tabs: [
      { id: 'tasks', label: 'Tasks', perm: 'task.read' },
      { id: 'performance', label: 'Goals', perm: 'goal.read' },
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
    id: 'messages',
    label: 'Messages',
    tabs: [{ id: 'messages', label: 'Messages', perm: null, needsEmployee: true }],
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
      // superOnly, not a permission: reading other people's conversations is the one power that
      // belongs to the account that owns the system and to nobody it can delegate to. Gating it on
      // rbac.manage would hand it to every entity admin, and app.can_read_conversation would then
      // return nothing for them — a tab that opens onto a permanently empty screen.
      { id: 'admin-chats', label: 'Chat Monitor', perm: null, superOnly: true },
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
export function canSeeTab(tab, { canAny, canBeyondSelf, hidden, isSuperAdmin = false, hasEmployee = true }) {
  // Accepts a Set (what predicatesFor builds) or a plain array (what a caller may hand over).
  const isHidden = hidden instanceof Set ? hidden.has(tab.id) : (hidden ?? []).includes(tab.id);
  if (isHidden) return false;
  /*
   * Some screens are about being a member of staff, not about holding a permission.
   *
   * Messaging is the one so far: a conversation's members are EMPLOYEES, so a login with no
   * employee record has nobody to send as and no inbox to fill. That is a legitimate account —
   * the super admin is deliberately a system login rather than a person — and offering it a
   * screen whose only possible content is an explanation of why it is empty is worse than not
   * offering it. A super admin reads conversations through the Chat Monitor instead.
   *
   * Defaults to true so every existing caller and every tab without the flag is unaffected.
   */
  if (tab.needsEmployee && !hasEmployee) return false;
  // Checked before the permission arms, and it both grants and REFUSES: a superOnly tab is closed
  // to everybody else however many permissions they hold, including a permissionless one that
  // `!tab.perm` would otherwise wave through.
  if (tab.superOnly) return Boolean(isSuperAdmin);
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
          // `group` rides along so the phone drawer can print the tree's own headings — Work, Me,
          // Support — instead of inventing its own. It used to head the first four "Today" and the
          // remainder "More", which described the bottom bar rather than the app.
          group.items.map((item) => ({
            id: item.id, label: item.label, group: group.title, tabs: [item],
          }))
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

/** How many sections the phone's bottom bar seats before the fifth becomes "More". */
export const MOBILE_NAV_SLOTS = 4;

/**
 * What the bottom bar offers, in order, and why it is a list rather than `sections.slice(0, 4)`.
 *
 * A slice makes the phone's four most valuable pieces of screen a side effect of sidebar order, so
 * moving one row in the tree silently rearranges the bar — which is how Pay came to hold a seat it
 * is opened once a month to use while Tasks, opened several times a day, had none.
 *
 * Stated here instead: the bar is for what somebody came to the app to do. Leave is on it despite
 * living under "Me" in the tree, because applying for it is frequent; Pay and Goals are not,
 * because they are not. A section named here that this viewer cannot see is skipped, and the bar
 * is topped up from tree order so it never renders short.
 */
export const MOBILE_PRIMARY_IDS = {
  employee: ['dashboard', 'tasks', 'attendance', 'leave'],
  oversight: ['home', 'work', 'time', 'people'],
};

/**
 * The sections this viewer's bottom bar seats, in bar order.
 *
 * Takes the sections already resolved for the viewer — this decides arrangement, never access.
 */
export function mobilePrimarySections(sections, primaryRole) {
  const wanted =
    primaryRole === 'employee' ? MOBILE_PRIMARY_IDS.employee : MOBILE_PRIMARY_IDS.oversight;

  const seated = [];
  for (const id of wanted) {
    const section = sections.find((s) => s.id === id);
    if (section) seated.push(section);
  }
  // Somebody who holds none of the named screens still gets a usable bar rather than one button.
  for (const section of sections) {
    if (seated.length >= MOBILE_NAV_SLOTS) break;
    if (!seated.includes(section)) seated.push(section);
  }
  return seated.slice(0, MOBILE_NAV_SLOTS);
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
export function predicatesFor(permissions, { isSuperAdmin = false, hiddenScreens = [], hasEmployee = true } = {}) {
  const list = permissions ?? [];
  // A super admin is never narrowed — matching 0109's trigger and its get_my_access branch. The
  // account that can undo an override must not be the one locked out by it.
  const hidden = new Set(isSuperAdmin ? [] : hiddenScreens ?? []);
  return {
    isSuperAdmin,
    hasEmployee,
    canAny: (perm) => isSuperAdmin || list.some((p) => p.permission === perm),
    canBeyondSelf: (perm) =>
      isSuperAdmin || list.some((p) => p.permission === perm && p.scope_type !== 'self'),
    hidden,
  };
}
