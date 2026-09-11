import rolePermissions from '../src/test/standardRolePermissions.json';
import { fixture } from './fixtures.js';

export const ROLE_NAMES = ['super_admin', 'entity_admin', 'hr_manager', 'zonal_manager', 'branch_manager', 'dept_head', 'employee'];
fixture.roles.splice(0, fixture.roles.length, ...ROLE_NAMES.map((key) => ({
  id: `role-${key}`, key, name: key.replaceAll('_', ' '), rank: rolePermissions[key]?.rank ?? 0,
  permissionKeys: rolePermissions[key]?.permissions ?? [], is_system: true,
})));
const selected = new URL(window.location.href).searchParams.get('qa-role');
export const qaRole = ROLE_NAMES.includes(selected) || selected === 'unassigned' ? selected : 'super_admin';
export const roleMode = selected != null;
const scopeTypes = { entity_admin: 'entity', hr_manager: 'entity', zonal_manager: 'zone',
  branch_manager: 'branch', dept_head: 'department', employee: 'self' };
const employee = fixture.employees[0];
const scopeType = scopeTypes[qaRole];
const scopeId = employee?.[`${scopeType}_id`] ?? null;
const selfGrants = (rolePermissions.employee?.permissions ?? []).map((permission) => ({ permission, scope_type: 'self', scope_id: null }));
export const qaAccess = { is_super_admin: qaRole === 'super_admin', rank: rolePermissions[qaRole]?.rank ?? 0,
  employee, permissions: qaRole === 'unassigned' ? [] : [
    ...selfGrants,
    ...(qaRole === 'employee' ? [] : (rolePermissions[qaRole]?.permissions ?? []).map((permission) => ({
      permission, scope_type: scopeType ?? 'global', scope_id: scopeId,
    }))),
  ],
  assignments: qaRole === 'unassigned' ? [] : [
    { role: qaRole, scope_type: scopeType ?? 'global', scope_id: scopeId },
    ...(qaRole === 'employee' ? [] : [{ role: 'employee', scope_type: 'self', scope_id: null }]),
  ], hidden_screens: [], must_change_password: false };

// This fixture adapter shapes sample responses for UI checks. Real PostgreSQL policies are
// exercised separately by the role database suite; this is not a security implementation.
export function fixtureAllows(permission, row) {
  if (qaAccess.is_super_admin) return true;
  const person = fixture.employees.find((e) => e.id === (row.employee_id ?? row.employee?.id ?? row.id)) ?? row;
  return qaAccess.permissions.some((grant) => grant.permission === permission && (
    grant.scope_type === 'global' || (grant.scope_type === 'self' ? person.id === employee.id
      : person[`${grant.scope_type}_id`] === grant.scope_id)
  ));
}
export const qaVisibleEmployees = fixture.employees.filter((row) => fixtureAllows('employee.read', row));
export const qaExpectedCounts = roleMode ? {
  super_admin: 525, entity_admin: 175, hr_manager: 175, zonal_manager: 88,
  branch_manager: 44, dept_head: 22, employee: 1, unassigned: 0,
} : { super_admin: 525 };

export const qaExpectedDashboard = {
  super_admin: ['Employees 525', 'Checked In 420'],
  entity_admin: ['Headcount 175', 'Checked In 140', 'Pending Leaves 174'],
  hr_manager: ['Headcount 175', 'Checked In 140', 'Pending Leaves 174'],
  zonal_manager: ['Headcount 88', 'Pending Approvals 174'],
  branch_manager: ['Team Size 44', 'Checked In 35', 'Absent Today 9', 'Pending Approvals 86'],
  dept_head: ['Team Size 22', 'Checked In 17', 'Absent Today 5', 'Pending Approvals 42'],
  employee: ['Tasks 1', 'Leave left 10', 'Absent 1'],
};

// Explicit standard-role expectations, independent of the application's nav predicates.
export function expectsDeniedScreen(route) {
  const screen = route.split('/')[0];
  if (qaRole === 'unassigned') return true;
  if (qaRole === 'super_admin') return false;
  if (screen === 'admin-chats') return true;
  if (['organization', 'admin-audit'].includes(screen)) return qaRole !== 'entity_admin';
  if (['attendance-admin', 'recruitment', 'onboarding'].includes(screen)) return !['entity_admin', 'hr_manager'].includes(qaRole);
  if (['directory', 'employee-import', 'attendance-person', 'team', 'assets', 'reports', 'administration', 'admin-roles'].includes(screen)) return qaRole === 'employee';
  return false;
}
