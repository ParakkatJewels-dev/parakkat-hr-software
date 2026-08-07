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

export function resolvePrimaryRole(assignments, isSuperAdmin) {
  if (isSuperAdmin) return 'super_admin';
  const held = new Set((assignments || []).map((a) => a.role));
  return ROLE_PRIORITY.find((r) => held.has(r)) || 'employee';
}

export function resolveHeldRoles(assignments, isSuperAdmin, permissions = []) {
  const held = new Set((assignments || []).map((a) => a.role).filter(Boolean));
  if (isSuperAdmin) held.add('super_admin');
  if ((permissions || []).some((p) => p.scope_type === 'self')) held.add('employee');
  return ROLE_PRIORITY.filter((r) => held.has(r));
}
