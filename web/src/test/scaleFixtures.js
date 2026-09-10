// Synthetic records only. Shared by UI scale tests and local visual checks.
export function accountFixtures(count = 675) {
  const entities = ['Jewellery', 'Manufacturing', 'Retail'].map((name, i) => ({
    id: `company-${i + 1}`, code: `C${i + 1}`, name: `Sample ${name}`, is_active: true,
  }));
  const branches = entities.map((e, i) => ({ id: `branch-${i + 1}`, entity_id: e.id,
    code: `B${i + 1}`, name: `Sample branch ${i + 1}`, is_active: true }));
  const roles = [
    { id: 'role-employee', key: 'employee', name: 'Employee', rank: 10, is_system: true, permissionKeys: [] },
    { id: 'role-hr', key: 'hr_manager', name: 'HR Manager', rank: 60, is_system: true, permissionKeys: [] },
    { id: 'role-super', key: 'super_admin', name: 'Super Admin', rank: 1000, is_system: true, permissionKeys: [] },
  ];
  const employees = Array.from({ length: count }, (_, i) => ({
    id: `person-${i + 1}`, user_id: `user-${i + 1}`, employee_code: `EMP${String(i + 1).padStart(4, '0')}`,
    full_name: `Sample Employee ${String(i + 1).padStart(4, '0')}`, email: `employee${i + 1}@example.test`,
    entity_id: entities[i % 3].id, entity: entities[i % 3], branch_id: branches[i % 3].id,
    branch: branches[i % 3], status: 'Active',
  }));
  const users = employees.map((e, i) => ({
    user_id: e.user_id, email: e.email, employee_id: e.id, employee_name: e.full_name,
    employee_code: e.employee_code, is_super_admin: false,
    roles: i % 15 === 0 ? [] : [{ assignment_id: `assignment-${i + 1}`, role_key: i % 10 === 0 ? 'hr_manager' : 'employee',
      role_name: i % 10 === 0 ? 'HR Manager' : 'Employee', scope_type: i % 10 === 0 ? 'entity' : 'self',
      scope_id: i % 10 === 0 ? e.entity_id : null }],
  }));
  return { users, employees, org: { entities, branches, zones: [], departments: [], designations: [] }, roles };
}
