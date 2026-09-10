// Restore HR data only AFTER fresh permissions have resolved, for this exact identity and scope.
// Canonical ordering avoids remounting the app when SQL aggregates return a different row order.
export function accessCacheScope(userId, access) {
  if (!userId || !access) return null;
  const rows = (values) => (values ?? []).map((row) =>
    typeof row === 'string' ? row : JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))
    ).sort();
  const e = access.employee;
  return JSON.stringify({
    userId,
    superAdmin: Boolean(access.is_super_admin),
    rank: access.rank ?? 0,
    passwordGate: Boolean(access.must_change_password),
    employee: e ? [e.id, e.entity_id, e.zone_id, e.branch_id, e.department_id] : null,
    assignments: rows(access.assignments),
    permissions: rows(access.permissions),
    hidden: rows(access.hidden_screens),
  });
}

// A throttled write from an unmounted provider must never recreate a signed-out user's cache.
export function guardedStorage(storage, isCurrent) {
  return {
    getItem: (key) => isCurrent() ? storage.getItem(key) : null,
    setItem: (key, value) => { if (isCurrent()) storage.setItem(key, value); },
    removeItem: (key) => storage.removeItem(key),
  };
}
