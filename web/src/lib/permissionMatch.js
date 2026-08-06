// The UI mirror of Postgres app.has_perm(_perm, _entity, _zone, _branch, _dept, _employee).
//
// Pure, and separate from the hook, because the hook pulls in Supabase through useAuth and so
// cannot be loaded by the test runner — and this is the one piece of the permission code that has
// to match the database exactly. It is NOT the security boundary; RLS is. Its job is to keep the
// interface from offering something the database will refuse.

/**
 * SQL equality, not JavaScript equality.
 *
 * In Postgres `ra.scope_id = _dept` yields NULL — not true — when either side is NULL, so a
 * department-scoped grant never matches a row with no department. Written the obvious way,
 * `p.scope_id === deptId` returns TRUE when both happen to be null, and the UI would then cheerfully
 * offer an insert the database refuses with "new row violates row-level security policy". That is
 * exactly the mismatch this file exists to prevent, so the null check is the whole point.
 */
const sameScope = (a, b) => a != null && b != null && a === b;

/**
 * Does `list` (the caller's flattened permission rows: { permission, scope_type, scope_id }) grant
 * `perm` over the resource described by `scope`?
 *
 * `scope` names the resource's ancestry — entityId, zoneId, branchId, deptId, employeeId — any of
 * which may be null when the resource does not sit at that level.
 */
export function hasPerm(list, perm, scope = {}, options = {}) {
  const { isSuperAdmin = false, myEmployeeId = null } = options;
  if (isSuperAdmin) return true;

  const { entityId = null, zoneId = null, branchId = null, deptId = null, employeeId = null } = scope;

  return (list ?? []).some((p) => {
    if (p.permission !== perm) return false;
    switch (p.scope_type) {
      case 'global':
        return true;
      case 'entity':
        return sameScope(p.scope_id, entityId);
      case 'zone':
        return sameScope(p.scope_id, zoneId);
      case 'branch':
        return sameScope(p.scope_id, branchId);
      case 'department':
        return sameScope(p.scope_id, deptId);
      case 'self':
        // The 'self' grant carries no scope_id — the constraint forbids one. It matches when the
        // resource IS the signed-in person's own record.
        return employeeId != null && employeeId === myEmployeeId;
      default:
        return false;
    }
  });
}

/**
 * The "working as an employee" lens.
 *
 * Rather than teach twenty screens about the view switcher, narrow the PERMISSIONS to the ones a
 * plain employee holds — the self-scoped ones — and every existing gate follows: Payroll drops its
 * manager tabs, Attendance drops the roster board, Tasks hides New Task, Directory refuses the
 * route. They were all written against these helpers already.
 *
 * Returns `viewingAsEmployee` too, because hiding the CONTROLS is only half of it: RLS still
 * returns the whole branch's rows, since the database answers to the account and not to a toggle.
 * Lists use it to narrow themselves to the signed-in employee.
 *
 * `effectiveSuperAdmin` matters more than it looks. hasPerm short-circuits to true for a super
 * admin, so filtering the list alone would leave them seeing everything while the app claimed they
 * were an employee.
 *
 * NOT A SECURITY BOUNDARY. Same class of mirror as hasPerm: it decides what to OFFER. A manager in
 * employee view is still a manager to Postgres, which is why the route guard and RLS both keep
 * asking the real question.
 *
 * Lives here, beside hasPerm, so it can be tested by importing it. The first version of this was
 * inline in usePermissions.js — which imports React and Supabase and therefore cannot be loaded by
 * the test runner — so its test reimplemented the rule and could not fail when the code broke.
 */
export function applyViewLens(permissions, { isSuperAdmin = false, chosenRole = null } = {}) {
  const raw = permissions ?? [];
  // A plain employee has nothing to set aside, so the lens must be a no-op for them rather than
  // stripping the grants they already have.
  const holdsMore = isSuperAdmin || raw.some((p) => p.scope_type !== 'self');
  const viewingAsEmployee = chosenRole === 'employee' && holdsMore;

  return {
    viewingAsEmployee,
    list: viewingAsEmployee ? raw.filter((p) => p.scope_type === 'self') : raw,
    effectiveSuperAdmin: viewingAsEmployee ? false : isSuperAdmin,
  };
}
