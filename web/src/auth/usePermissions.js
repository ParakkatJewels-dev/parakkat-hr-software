// UI-side permission checks. These MIRROR the Postgres app.has_perm() function so the interface
// only shows what the user can actually do — but they are NOT the security boundary. RLS is.
// (A user who bypasses these checks still gets nothing back from the database.)
import { useMemo } from 'react';
import { useAuth } from './AuthContext';

export function usePermissions() {
  const { permissions, isSuperAdmin, employee } = useAuth();

  return useMemo(() => {
    const list = permissions || [];
    const myEmployeeId = employee?.id ?? null;

    // Does the user hold `perm` at ANY scope? Used for nav / whole-module visibility.
    const canAny = (perm) => isSuperAdmin || list.some((p) => p.permission === perm);

    // Does the user hold `perm` at a scope BROADER than their own record (i.e. they can act on
    // OTHER people's data)? An employee holds e.g. employee.read only at 'self' scope, so this is
    // false for them — used to keep oversight modules (Directory, org KPIs) out of the ESS view.
    const canBeyondSelf = (perm) =>
      isSuperAdmin || list.some((p) => p.permission === perm && p.scope_type !== 'self');

    // Precise check against one resource's ancestry — mirrors app.has_perm(perm, entity, zone, branch, dept, employee).
    const can = (perm, scope = {}) => {
      if (isSuperAdmin) return true;
      const { entityId, zoneId, branchId, deptId, employeeId } = scope;
      return list.some((p) => {
        if (p.permission !== perm) return false;
        switch (p.scope_type) {
          case 'global':
            return true;
          case 'entity':
            return p.scope_id === entityId;
          case 'zone':
            return p.scope_id === zoneId;
          case 'branch':
            return p.scope_id === branchId;
          case 'department':
            return p.scope_id === deptId;
          case 'self':
            return employeeId != null && employeeId === myEmployeeId;
          default:
            return false;
        }
      });
    };

    return { can, canAny, canBeyondSelf, isSuperAdmin };
  }, [permissions, isSuperAdmin, employee]);
}
