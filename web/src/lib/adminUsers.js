export function employeeScope(employee) {
  if (!employee) return null;
  return { entityId: employee.entity_id, zoneId: employee.zone_id, branchId: employee.branch_id,
    deptId: employee.department_id, employeeId: employee.id };
}

// Mirrors delete_login's rank AND employee-scope checks. Unknown roles fail closed in the UI.
export function canManageUser(target, { isSuperAdmin, myRank, roles, employees, can }) {
  if (isSuperAdmin) return true;
  if (target.is_super_admin || !target.employee_id) return false;
  const roleMap = new Map(roles.map((r) => [r.key, r]));
  const assigned = target.roles ?? [];
  if (assigned.some((r) => r.role_key === 'super_admin' || !roleMap.has(r.role_key))) return false;
  const rank = Math.max(0, ...assigned.map((r) => roleMap.get(r.role_key).rank ?? Infinity));
  if (rank >= myRank) return false;
  const scope = employeeScope(employees.find((e) => e.id === target.employee_id));
  return Boolean(scope && can('rbac.manage', scope));
}

export function assignmentScope(assignment, target, employees, org) {
  if (assignment.scope_type === 'self') return employeeScope(employees.find((e) => e.id === target.employee_id));
  const id = assignment.scope_id;
  if (assignment.scope_type === 'entity') return org.entities.some((e) => e.id === id) ? { entityId: id } : null;
  if (assignment.scope_type === 'zone') {
    const z = org.zones.find((r) => r.id === id);
    return z ? { entityId: z.entity_id, zoneId: z.id } : null;
  }
  if (assignment.scope_type === 'branch') {
    const b = org.branches.find((r) => r.id === id);
    return b ? { entityId: b.entity_id, zoneId: b.zone_id, branchId: b.id } : null;
  }
  if (assignment.scope_type === 'department') {
    const d = org.departments.find((r) => r.id === id);
    return d ? { entityId: d.entity_id, zoneId: org.branches.find((b) => b.id === d.branch_id)?.zone_id,
      branchId: d.branch_id, deptId: d.id } : null;
  }
  return null;
}

export function hasAssignment(assignments, roleKey, scopeType, scopeId) {
  return (assignments ?? []).some((r) => r.role_key === roleKey && r.scope_type === scopeType
    && (r.scope_id ?? null) === (scopeId || null));
}

export async function revokeRole(client, assignmentId) {
  const { data, error } = await client.from('role_assignments').delete().eq('id', assignmentId).select('id');
  if (error) throw error;
  if (!data?.length) throw new Error('This role was not removed. It may already be removed, or you no longer have permission. Refresh the users list.');
}

export async function createManagedUser(client, { email, password, employee_id, super_admin = false }) {
  const { data: userId, error } = await client.rpc('admin_create_user_with_employee', {
    _email: email.trim(), _password: password, _employee: employee_id || null, _super_admin: super_admin,
  });
  if (error?.code === 'PGRST202') throw new Error('User creation needs database migration 0120_user_account_integrity.sql. Ask your system administrator to apply it.');
  if (error) throw error;
  if (!userId) throw new Error('The server did not return the created user. Refresh before trying again.');
  return { user_id: userId, email: email.trim() };
}

export async function refreshUserAdministration(qc) {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('app:access-changed'));
  await Promise.all(['managed-users', 'employees', 'employee', 'roles', 'roles-with-perms', 'screen-overrides']
    .map((key) => qc.invalidateQueries({ queryKey: [key] })));
}
