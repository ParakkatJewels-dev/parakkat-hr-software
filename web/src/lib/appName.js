import { ROLE_PRIORITY } from './roles.js';

export const ORG_NAME = 'Parakkat';
export const PRODUCT_NAME = ORG_NAME;

// One set of names for the app, install guidance, and public manifests. Every manifest keeps
// the same id/start_url: these are views of one app, not separate permissions.
export const APP_IDENTITIES = {
  default: { name: PRODUCT_NAME, manifestHref: '/manifest.webmanifest' },
  admin: { name: 'Parakkat Admin', manifestHref: '/manifests/admin.webmanifest' },
  hr: { name: 'Parakkat HR', manifestHref: '/manifests/hr.webmanifest' },
  manager: { name: 'Parakkat Manager', manifestHref: '/manifests/manager.webmanifest' },
  employee: { name: 'Parakkat Employee', manifestHref: '/manifests/employee.webmanifest' },
};

const FAMILY_BY_ROLE = {
  super_admin: 'admin',
  entity_admin: 'admin',
  hr_manager: 'hr',
  zonal_manager: 'manager',
  branch_manager: 'manager',
  dept_head: 'manager',
  employee: 'employee',
};

export function appIdentityFor(role) {
  const family = Object.hasOwn(FAMILY_BY_ROLE, role) ? FAMILY_BY_ROLE[role] : 'default';
  return APP_IDENTITIES[family];
}

export function appNameFor(role) {
  return appIdentityFor(role).name;
}

// Use actual assignments for the installed name. The optional workspace-view switch is only a
// presentation preference. Unknown/custom roles get the neutral brand, not an employee label.
export function appRoleFor(assignments, isSuperAdmin) {
  if (isSuperAdmin) return 'super_admin';
  const held = new Set((assignments ?? []).map(assignment => assignment.role));
  return ROLE_PRIORITY.find(role => held.has(role)) ?? null;
}

export function documentTitleFor(role, screen) {
  const name = appNameFor(role);
  return screen ? `${screen} · ${name}` : name;
}
