// Role seniority shared by the dashboard presets and the role-aware sidebar.
// A multi-role user is presented the layout of their HIGHEST role; permission gates on
// individual widgets/nav items still apply the union of everything they hold.
export const ROLE_PRIORITY = [
  'super_admin',
  'entity_admin',
  'hr_manager',
  'zonal_manager',
  'branch_manager',
  'dept_head',
  'employee',
];

const MANAGER_ROLES = new Set(ROLE_PRIORITY.filter((role) => role !== 'super_admin' && role !== 'employee'));

export function resolvePrimaryRole(assignments, isSuperAdmin) {
  if (isSuperAdmin) return 'super_admin';
  const held = new Set((assignments || []).map((a) => a.role));
  return ROLE_PRIORITY.find((r) => held.has(r)) || 'employee';
}

export function resolveHeldRoles(assignments, isSuperAdmin, permissions = [], employee = null) {
  const held = new Set((assignments || []).map((a) => a.role).filter(Boolean));
  if (isSuperAdmin) held.add('super_admin');
  const linkedToEmployee = Boolean(employee?.id);
  const hasSelfServiceGrant = (permissions || []).some((p) => p.scope_type === 'self');
  const hasManagerRole = [...held].some((role) => MANAGER_ROLES.has(role));
  if (hasSelfServiceGrant || (linkedToEmployee && (hasManagerRole || isSuperAdmin))) {
    held.add('employee');
  }
  return ROLE_PRIORITY.filter((r) => held.has(r));
}
