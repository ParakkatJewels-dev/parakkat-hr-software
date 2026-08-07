// UI-side permission checks. These MIRROR the Postgres app.has_perm() function so the interface
// only shows what the user can actually do — but they are NOT the security boundary. RLS is.
// (A user who bypasses these checks still gets nothing back from the database.)
import { useMemo, useSyncExternalStore } from 'react';
import { useAuth } from './AuthContext';
import { hasPerm, applyViewLens } from '../lib/permissionMatch';
import { getChosenRole, resolveChosenRole, subscribeToViewRole } from '../lib/viewRole';
import { resolveHeldRoles } from '../lib/roles';

export function usePermissions() {
  const { permissions, isSuperAdmin, employee, assignments } = useAuth();
  // The role the person chose to work as (Settings -> Switch view). Read here rather than passed
  // down because EVERY screen already calls this hook and none of them take a viewRole prop — which
  // is exactly why the first version of the switcher changed the sidebar and nothing else.
  const chosen = useSyncExternalStore(subscribeToViewRole, getChosenRole, () => null);

  return useMemo(() => {
    const raw = permissions || [];
    const myEmployeeId = employee?.id ?? null;
    const validChosen = resolveChosenRole(
      chosen,
      resolveHeldRoles(assignments, isSuperAdmin, raw, employee),
      null
    );

    // The lens lives in permissionMatch.js so it can be tested by importing it — see the note
    // there. This hook is untestable by construction: it imports Supabase through useAuth.
    const { list, viewingAsEmployee, effectiveSuperAdmin } =
      applyViewLens(raw, { isSuperAdmin, chosenRole: validChosen });

    // Does the user hold `perm` at ANY scope? Used for nav / whole-module visibility.
    const canAny = (perm) => effectiveSuperAdmin || list.some((p) => p.permission === perm);

    // Does the user hold `perm` at a scope BROADER than their own record (i.e. they can act on
    // OTHER people's data)? An employee holds e.g. employee.read only at 'self' scope, so this is
    // false for them — used to keep oversight modules (Directory, org KPIs) out of the ESS view.
    const canBeyondSelf = (perm) =>
      effectiveSuperAdmin || list.some((p) => p.permission === perm && p.scope_type !== 'self');

    // Precise check against one resource's ancestry — mirrors app.has_perm(perm, entity, zone, branch, dept, employee).
    //
    // The matching itself lives in lib/permissionMatch.js so it can be tested: this file imports
    // useAuth, which imports Supabase, which the test runner cannot load. The version that used to
    // be inlined here compared scope ids with ===, which reads null === null as a match where
    // Postgres reads NULL = NULL as NULL. See permissionMatch.test.js.
    const can = (perm, scope = {}) =>
      hasPerm(list, perm, scope, { isSuperAdmin: effectiveSuperAdmin, myEmployeeId });

    /**
     * Does the user hold `perm` at a scope that spans WHOLE BRANCHES — the UI mirror of
     * resolveVisibleScope() in services/attendance/src/api/auth.ts.
     *
     * That resolver builds its branch list from global, entity, zone and branch grants only:
     * department and self grants deliberately contribute nothing, because the exports it guards
     * emit whole-branch sheets and a narrower grant would be silently widened. A caller whose
     * grants resolve to nothing gets a 403, so `canBeyondSelf` is too generous here — it is true
     * for a department-scoped grant, and the button would be a dead control.
     */
    const canAcrossBranches = (perm) =>
      effectiveSuperAdmin
      || list.some(
        (p) =>
          p.permission === perm
          && (p.scope_type === 'global'
            || p.scope_type === 'entity'
            || p.scope_type === 'zone'
            || p.scope_type === 'branch')
      );

    return {
      can, canAny, canBeyondSelf, canAcrossBranches,
      isSuperAdmin: effectiveSuperAdmin,
      // For lists that must narrow to the signed-in employee: hiding the manager CONTROLS does not
      // stop RLS returning the whole branch's rows.
      viewingAsEmployee,
    };
  }, [permissions, isSuperAdmin, employee, assignments, chosen]);
}
