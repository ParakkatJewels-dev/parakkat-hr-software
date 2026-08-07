// Which roles may this person hand out?
//
// Kept out of the component so it can be tested by importing it: GrantAccessPanel reaches Supabase
// through useAuth, which the test runner cannot load. Same reason permissionMatch.js is separate.
//
// The database enforces all of this independently in app.can_grant / app.max_grantable_rank
// (migrations 0044 and 0091). Nothing here is a security boundary — it only keeps the UI from
// offering a choice that was always going to come back refused.

// What each system role means in plain language, and which field of the employee's own record
// decides the area it applies to. Order = seniority, matching the dashboards and the sidebar.
// `rank` mirrors public.roles.rank (migration 0044).
export const ROLE_PRESETS = [
  {
    key: 'employee',
    rank: 10,
    label: 'Employee (self-service)',
    blurb: 'Sees only their own attendance, leave, payslips and tasks.',
    scopeType: 'self',
    from: null,
  },
  {
    key: 'dept_head',
    rank: 30,
    label: 'Department Head',
    blurb: 'Manages their department: attendance, leave approvals, tasks, performance.',
    scopeType: 'department',
    from: 'department_id',
  },
  {
    key: 'branch_manager',
    rank: 40,
    label: 'Branch Manager (Shop-in-charge)',
    blurb: 'Manages their branch: attendance, approvals, expenses, assets, tickets.',
    scopeType: 'branch',
    from: 'branch_id',
  },
  {
    key: 'zonal_manager',
    rank: 50,
    label: 'Zonal Manager',
    blurb: 'Oversees every branch in their zone: reports and approvals.',
    scopeType: 'zone',
    from: 'zone_id',
  },
  {
    key: 'hr_manager',
    rank: 60,
    label: 'HR Manager',
    blurb: 'People operations across their company: hiring, onboarding, exits, attendance setup.',
    scopeType: 'entity',
    from: 'entity_id',
  },
  {
    key: 'entity_admin',
    rank: 80,
    label: 'Entity Admin',
    blurb: 'Full administrator of their company, including users and roles.',
    scopeType: 'entity',
    from: 'entity_id',
  },
];

const RANK_BY_ROLE = Object.fromEntries(ROLE_PRESETS.map((r) => [r.key, r.rank]));

const roleKeyOf = (role) => (typeof role === 'string' ? role : role?.role ?? role?.key);
const roleRankOf = (role) => {
  const key = roleKeyOf(role);
  if (typeof role === 'object' && role && Number.isFinite(Number(role.rank))) {
    return Number(role.rank);
  }
  return RANK_BY_ROLE[key];
};

/**
 * Ceilings lower than seniority alone would give.
 *
 * Rank answers "who outranks whom", which is the wrong question for delegation. HR outranks a
 * zonal manager on the org chart, so the rank rule let an HR manager appoint one — and appointing a
 * zonal or a branch manager is not a people-operations decision. It settles who reports to whom,
 * which belongs to the entity admin. HR hires, onboards and exits; the most senior thing they hand
 * out is a department head, so a small team can still be stood up without waiting on an admin.
 *
 * Keyed by role rather than by rank, so renumbering a rank cannot quietly widen it.
 */
export const GRANT_CEILING = { hr_manager: 30 };

/**
 * The highest rank this person may grant.
 *
 * HR is capped when HR is the highest role the person holds, matching migration 0091's
 * app.max_grantable_rank(). Somebody who is both an HR manager and an entity admin is an entity
 * admin, and the other hat they wear must not demote them. Outside that special case, every role
 * carries its own ceiling and the most generous one wins. A role this module does not know
 * (super_admin, or one added later) falls back to `myRank`, which comes from the database's own
 * app.max_role_rank.
 */
export function maxGrantableRank(myRank, myRoles = []) {
  const roles = myRoles ?? [];
  if (roles.some((role) => roleKeyOf(role) === 'hr_manager') && myRank <= RANK_BY_ROLE.hr_manager) {
    return GRANT_CEILING.hr_manager;
  }
  const ceilings = roles
    .map((role) => {
      const key = roleKeyOf(role);
      const rank = roleRankOf(role);
      if (!Number.isFinite(rank)) return null;
      return GRANT_CEILING[key] ?? rank - 1;
    })
    .filter((rank) => rank != null);

  // Anything unrecognised without a rank — or no roles at all — is answered by seniority, the 0044
  // rule: strictly below your own level. Runtime assignments include rank from get_my_access(); the
  // fallback keeps older tests and super_admin's pseudo-role working.
  if (ceilings.length !== roles.length || roles.length === 0) ceilings.push(myRank - 1);

  return Math.max(...ceilings);
}

/** The presets the signed-in user is actually allowed to hand out. */
export function grantableRoles(myRank, myRoles = []) {
  const ceiling = maxGrantableRank(myRank, myRoles);
  return ROLE_PRESETS.filter((r) => r.rank <= ceiling);
}
