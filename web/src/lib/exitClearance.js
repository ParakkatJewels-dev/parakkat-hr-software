export const EXIT_DEPARTMENTS = ['IT', 'Admin', 'Finance', 'HR'];

export function canManageExit(exit, { employeeId, userId, viewingAsEmployee, can }) {
  return !viewingAsEmployee && ['Clearance in Progress', 'Cleared'].includes(exit.status)
    && (exit.employee_id ?? exit.employee?.id) !== employeeId
    && !(exit.created_by && exit.created_by === userId)
    && can('exit.manage', { employeeId: exit.employee_id ?? exit.employee?.id,
      entityId: exit.entity_id ?? exit.employee?.entity_id,
      zoneId: exit.zone_id ?? exit.employee?.zone_id,
      branchId: exit.branch_id ?? exit.employee?.branch_id,
      deptId: exit.department_id ?? exit.employee?.department_id });
}

export function exitReadyToComplete(exit) {
  return exit.status === 'Cleared' && EXIT_DEPARTMENTS.every(department => exit.approvals?.[department] === 'Approved');
}
