import { useAuth } from '../../auth/AuthContext';
import { usePermissions } from '../../auth/usePermissions';

// Reading a request does not imply permission to decide it. Keep the dashboard's totals,
// priorities and inline decisions consistent with the full leave/expense/correction screens.
export function useActionableApprovals({ leaves = [], expenses = [], regs = [] }) {
  const { employee, user } = useAuth();
  const { can } = usePermissions();
  const actionable = (row, permission) => row.status === 'Pending'
    && (!employee?.id || (row.employee_id ?? row.employee?.id) !== employee.id)
    && !(permission === 'expense.approve' && row.created_by && row.created_by === user?.id)
    && can(permission, {
      entityId: row.entity_id,
      zoneId: row.zone_id,
      branchId: row.branch_id,
      deptId: row.department_id,
      employeeId: row.employee_id ?? row.employee?.id,
    });
  const pendingLeaves = leaves.filter((row) => actionable(row, 'leave.approve'));
  const pendingExpenses = expenses.filter((row) => actionable(row, 'expense.approve'));
  const pendingPunches = regs.filter((row) => actionable(row, 'regularization.approve'));
  return {
    leaves: pendingLeaves, expenses: pendingExpenses, punches: pendingPunches,
    total: pendingLeaves.length + pendingExpenses.length + pendingPunches.length,
  };
}
