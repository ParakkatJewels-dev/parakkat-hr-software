// The fail-closed decisions behind resolveScopedEmployeeIds, kept apart from the SQL.
//
// This service reads through a connection that bypasses RLS, so these rules are the only thing
// standing between a branch-scoped grant and an operation that rewrites every employee's
// attendance. They live here, free of any database import, so they can be tested directly —
// importing api/auth.ts pulls in lib/db, which needs a live DATABASE_URL just to construct.
//
// The dangerous failure is never "returned too few". It is returning ALL for someone who should
// have been refused, so every branch below either names an explicit id list or says NONE.

/** What resolveVisibleScope decided the caller can see. */
export interface VisibleScope {
  all: boolean;
  branchIds: string[];
  entityIds: string[];
}

export type Selection =
  /** The whole organisation, or exactly `ids` if the caller asked for specific employees. */
  | { kind: 'all'; ids: string[] | null }
  /** Nobody. The caller's grants confer no authority over any employee — routes answer 403. */
  | { kind: 'none' }
  /** Everyone under these branches or entities, to be narrowed by `narrow()` afterwards. */
  | { kind: 'branchesAndEntities'; branchIds: string[]; entityIds: string[] };

/**
 * Turn a resolved scope into the set of employees the caller may act on.
 *
 * `all` is reserved for super admins and global grants — resolveVisibleScope sets it nowhere else.
 * A scope with no branches and no entities means the caller holds the permission only at
 * department or self level, which confers no authority over other people's records: that is NONE,
 * not everyone, and getting this one line backwards is the whole bug class.
 */
export function selectionFor(scope: VisibleScope, requested?: string[]): Selection {
  if (scope.all) return { kind: 'all', ids: requested?.length ? [...requested] : null };
  if (!scope.branchIds.length && !scope.entityIds.length) return { kind: 'none' };
  return { kind: 'branchesAndEntities', branchIds: scope.branchIds, entityIds: scope.entityIds };
}

/**
 * Intersect what the caller asked for with what they are allowed.
 *
 * Narrowing only: an id outside the allowed set is dropped, never granted. An ask that is entirely
 * out of scope therefore comes back empty, which routes must read as a refusal.
 */
export function narrow(allowed: string[], requested?: string[]): string[] {
  if (!requested?.length) return allowed;
  const set = new Set(allowed);
  return requested.filter((id) => set.has(id));
}
