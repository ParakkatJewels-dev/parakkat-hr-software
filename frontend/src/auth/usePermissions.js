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

    return { can, canAny, isSuperAdmin };
  }, [permissions, isSuperAdmin, employee]);
}
