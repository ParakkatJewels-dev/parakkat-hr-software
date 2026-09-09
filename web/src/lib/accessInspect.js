// What one person can actually do, and where each piece of it came from.
//
// Users & Access is organised around the ROLE: pick a role, see who holds it. The question an
// administrator actually arrives with is the other one — "what can Ramesh reach, and why?" — and
// answering it today means reading a row of role chips and holding the permission matrix in your
// head. This module does that arithmetic.
//
// Provenance is the point. A permission is rarely held for one reason: the cumulative ladder
// (0080) means a branch manager holds a department head's grants too, and every manager also holds
// the self-service set (0096). Showing "leave.approve ✓" is not useful; showing "leave.approve —
// via branch_manager, over branch Thrissur" is, because it tells you which role to take away.
//
// Pure, so it can be tested: the caller passes the role catalogue and the user's assignments, both
// of which Administration already loads.

/** Scope each role's grants land at, from ROLE_PRESETS in roleGrants.js. */
const SCOPE_OF_ROLE = {
  entity_admin: 'entity',
  hr_manager: 'entity',
  zonal_manager: 'zone',
  branch_manager: 'branch',
  dept_head: 'department',
  employee: 'self',
};

/**
 * Every permission a user effectively holds, each tagged with the assignment that granted it.
 *
 * `assignments` are the user's role_assignments rows: { role_key, scope_type, scope_id }.
 * `permissionsByRole` maps a role key to the permission keys it carries — the role catalogue
 * Administration already has from useRoles(), which reflects the ladder as the database holds it.
 *
 * One permission can appear more than once, at different scopes, from different roles. That is the
 * useful shape: it is exactly what you have to unpick to take an ability away.
 */
export function effectiveAccess(assignments = [], permissionsByRole = {}, { isSuperAdmin = false } = {}) {
  if (isSuperAdmin) {
    const every = new Set(Object.values(permissionsByRole).flat());
    return [...every].sort().map((permission) => ({
      permission,
      scope_type: 'global',
      scope_id: null,
      via: 'super_admin',
    }));
  }

  const out = [];
  for (const a of assignments) {
    const roleKey = a.role_key ?? a.role;
    const keys = permissionsByRole[roleKey] ?? [];
    // An assignment carries its own scope; fall back to the role's natural one when it is absent.
    const scopeType = a.scope_type ?? SCOPE_OF_ROLE[roleKey] ?? 'self';
    for (const permission of keys) {
      out.push({ permission, scope_type: scopeType, scope_id: a.scope_id ?? null, via: roleKey });
    }
  }
  return out;
}

/**
 * The same list folded by permission: one row per ability, carrying every route to it.
 *
 * Sorted by permission key so the panel reads alphabetically and does not reshuffle when a role
 * is granted — an administrator comparing two users should be looking at the same row order.
 */
export function groupByPermission(access = []) {
  const byKey = new Map();
  for (const entry of access) {
    if (!byKey.has(entry.permission)) byKey.set(entry.permission, []);
    byKey.get(entry.permission).push(entry);
  }
  return [...byKey.entries()]
    .map(([permission, sources]) => ({
      permission,
      sources,
      // Held beyond self scope means it reaches OTHER people's records — the distinction that
      // decides whether a screen is an oversight tool or a self-service one.
      beyondSelf: sources.some((s) => s.scope_type !== 'self'),
    }))
    .sort((a, b) => a.permission.localeCompare(b.permission));
}

/**
 * Abilities worth a second look on a person's record.
 *
 * Deliberately not called "violations" — none of these is wrong by itself, and an entity admin
 * legitimately holds all of them. They are the ones where the answer to "should this person have
 * this?" is a decision somebody made rather than an obvious yes, so the panel puts them where the
 * administrator will see them instead of leaving them in a list of forty-five keys.
 *
 * `roleKey` names the least senior role that carries the grant, because that is the one whose
 * removal would take it away.
 */
export const SENSITIVE = [
  {
    permission: 'employee.update',
    label: 'Can edit bank, PAN, Aadhaar and UAN',
    why: 'The Directory edit form carries bank account, IFSC and statutory ids alongside name and designation. Only salary is separately gated.',
    severity: 'high',
  },
  {
    permission: 'payslip.read',
    label: 'Can read other people’s payslips',
    why: 'Held beyond self scope, this opens the pay of everyone in their area. Migration 0100 removes it below HR.',
    severity: 'high',
    beyondSelfOnly: true,
  },
  {
    permission: 'document.read',
    label: 'Can read other people’s documents',
    why: 'Identity papers, contracts and letters for their whole area. Migration 0100 removes it below HR.',
    severity: 'high',
    beyondSelfOnly: true,
  },
  {
    permission: 'rbac.manage',
    label: 'Can grant and revoke roles',
    why: 'Capped to roles below their own rank, but it also exposes the whole permission model on the Roles screen.',
    severity: 'medium',
  },
  {
    permission: 'employee.create',
    label: 'Can create and bulk-import employees',
    why: 'Easy Time Pro is the enrolment source of truth; a second import path is how the two drift apart.',
    severity: 'medium',
  },
  {
    permission: 'payroll.manage',
    label: 'Can set salaries and run payroll',
    why: 'Configuring a structure and executing the run are one grant here, so one person can do both unchecked.',
    severity: 'medium',
  },
  {
    permission: 'employee.delete',
    label: 'Can delete employee records',
    why: 'Irreversible from the interface.',
    severity: 'high',
  },
  {
    permission: 'audit.read',
    label: 'Can read the audit trail',
    why: 'Expected for an administrator; worth noticing on anyone else.',
    severity: 'low',
  },
];

/** Which sensitive abilities this person holds, most severe first. */
export function accessFlags(access = []) {
  const grouped = groupByPermission(access);
  const byKey = new Map(grouped.map((g) => [g.permission, g]));
  const order = { high: 0, medium: 1, low: 2 };

  return SENSITIVE
    .map((rule) => {
      const held = byKey.get(rule.permission);
      if (!held) return null;
      // payslip.read and document.read are held by EVERYONE at self scope — that is just having
      // your own payslip, and flagging it would bury the real finding under noise.
      if (rule.beyondSelfOnly && !held.beyondSelf) return null;
      return { ...rule, sources: held.sources, beyondSelf: held.beyondSelf };
    })
    .filter(Boolean)
    .sort((a, b) => order[a.severity] - order[b.severity]);
}

/** A short human summary for the top of the panel. */
export function accessSummary(access = []) {
  const grouped = groupByPermission(access);
  return {
    total: grouped.length,
    beyondSelf: grouped.filter((g) => g.beyondSelf).length,
    selfOnly: grouped.filter((g) => !g.beyondSelf).length,
    flags: accessFlags(access).length,
  };
}
