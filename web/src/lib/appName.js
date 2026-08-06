// What this application calls itself, which depends on who opened it.
//
// The sidebar said "HR SYSTEM" to everybody. For the people who run HR that is accurate; for the
// 160-odd employees whose entire use of it is punching in, checking a payslip and asking for a
// day off, it names somebody else's tool and reads as "you are in the wrong place". The app
// already draws exactly this line — App.jsx hands an employee `essSections` under the heading
// "My Workspace" while everyone else gets the oversight tree — so the title now agrees with the
// screen underneath it instead of contradicting it.
//
// Each name states the SCOPE of what you are looking at, which is the honest difference between
// these roles: a branch manager and a zonal manager see the same screens, differing only in how
// much of the company appears in them.

/** The product, as distinct from the view of it. Used where the brand matters more than the role. */
export const PRODUCT_NAME = 'Parakkat HR';

/** The company, for the browser tab — where "Parakkat HR" next to "HR System" reads as a stutter. */
export const ORG_NAME = 'Parakkat';

const BY_ROLE = {
  employee: 'My Workspace',
  dept_head: 'Department HR',
  branch_manager: 'Branch HR',
  zonal_manager: 'Zone HR',
  hr_manager: 'HR System',
  entity_admin: 'Company HR',
  super_admin: 'HR Console',
};

/**
 * The name to show a holder of `role`.
 *
 * Falls back to the product name rather than to any single role's name: an unknown role means a
 * custom one somebody created, and calling that "My Workspace" would promise a self-service view
 * they may not have, while calling it "HR Console" would promise the opposite.
 */
export function appNameFor(role) {
  return BY_ROLE[role] ?? PRODUCT_NAME;
}

/**
 * The browser tab.
 *
 * Role first, because that is what distinguishes one of this user's tabs from another; the company
 * trails it so a tab is still identifiable in a window full of unrelated ones. `screen` is the
 * section currently open, and is omitted on the dashboard where it would just repeat the name.
 */
export function documentTitleFor(role, screen) {
  const name = appNameFor(role);
  // The fallback name already carries the company, so appending it again gives "Parakkat HR ·
  // Parakkat". Every role-specific name needs the suffix; only this one already has it.
  const base = name === PRODUCT_NAME ? name : `${name} · ${ORG_NAME}`;
  return screen ? `${screen} · ${base}` : base;
}
