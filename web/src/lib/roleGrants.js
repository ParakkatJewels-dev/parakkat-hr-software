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

  // Seniority always speaks too — the 0044 rule: strictly below your own level. Not only a
  // fallback for unrecognised roles: for a super admin it is the whole answer, because their rank
  // (1000) comes from the is_super_admin flag and not from any assignment, while their one
  // visible assignment is often employee@self (auto-granted to every login linked to an employee
  // record). Deriving the ceiling from held roles alone read that person as an employee — ceiling
  // 9, zero offerable roles, and a grant form silently falling back to employee. The SQL mirror
  // (0091 app.max_grantable_rank) never had this hole; its else-branch is max_role_rank() - 1,
  // and this line is what keeps the two rules the same rule. The HR cap is unaffected — it
  // returned above, before seniority is consulted.
  ceilings.push(myRank - 1);

  return Math.max(...ceilings);
}

// A custom role carrying user or organisation administration is only for admins (rank 80+), as in
// Administration's own role picker; app.can_grant applies the same rule in the database.
const ADMIN_PERMISSION_KEYS = new Set(['rbac.manage', 'org.manage']);
export const carriesAdminAuthority = (role) =>
  (role?.permissionKeys ?? []).some((key) => ADMIN_PERMISSION_KEYS.has(key));

/**
 * Where a custom role applies, read off the employee's own record like the presets' `from`. A
 * custom role has no natural level, so the person granting it chooses; the narrowest comes first
 * and is the default. "Only their own records" is the super admin's alone, as in Administration.
 */
export const CUSTOM_ROLE_LEVELS = [
  { scopeType: 'department', from: 'department_id', label: 'Their department' },
  { scopeType: 'branch', from: 'branch_id', label: 'Their branch' },
  { scopeType: 'zone', from: 'zone_id', label: 'Their zone' },
  { scopeType: 'entity', from: 'entity_id', label: 'Their company' },
  { scopeType: 'self', from: null, label: 'Only their own records', superAdminOnly: true },
];
export const customRoleLevel = (scopeType) => CUSTOM_ROLE_LEVELS.find((l) => l.scopeType === scopeType) ?? CUSTOM_ROLE_LEVELS[0];

/**
 * The roles the signed-in user is actually allowed to hand out: the built-in presets, then the
 * custom roles made in Administration → Roles (pass the catalogue from useRoles()). Custom roles
 * obey the same ceiling, and ones carrying admin authority need an admin. Without a catalogue only
 * the presets come back, as before.
 */
export function grantableRoles(myRank, myRoles = [], catalogue = []) {
  const ceiling = maxGrantableRank(myRank, myRoles);
  const builtIn = new Set([...ROLE_PRESETS.map((r) => r.key), 'super_admin']);
  const custom = (catalogue ?? [])
    .filter((role) => role?.key && !role.is_system && !builtIn.has(role.key)
      && (Number(role.rank) || 20) <= ceiling && (!carriesAdminAuthority(role) || myRank >= 80))
    .map((role) => ({
      key: role.key,
      rank: Number(role.rank) || 20,
      label: role.name || role.key,
      blurb: role.description || 'A custom role made in Administration → Roles.',
      custom: true,
      scopeType: CUSTOM_ROLE_LEVELS[0].scopeType,
      from: CUSTOM_ROLE_LEVELS[0].from,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [...ROLE_PRESETS.filter((r) => r.rank <= ceiling), ...custom];
}

/**
 * Every area a role can apply to, in plain words, narrowest first. "Area" is what the database
 * calls scope: the role says what someone can do, the area says where.
 */
export const AREA_LEVELS = [
  { scopeType: 'self', label: 'Their own records', noun: null, from: null },
  { scopeType: 'department', label: 'A department', noun: 'department', from: 'department_id' },
  { scopeType: 'branch', label: 'A branch', noun: 'branch', from: 'branch_id' },
  { scopeType: 'zone', label: 'A zone', noun: 'zone', from: 'zone_id' },
  { scopeType: 'entity', label: 'A whole company', noun: 'company', from: 'entity_id' },
  { scopeType: 'global', label: 'The whole group', noun: null, from: null },
];
export const areaLevel = (scopeType) => AREA_LEVELS.find((level) => level.scopeType === scopeType) ?? null;

/** Where each built-in role may apply — the database guard (migration 0019). The first is the usual one. */
export const ROLE_AREAS = {
  super_admin: ['global'],
  entity_admin: ['entity'],
  hr_manager: ['entity', 'zone', 'branch', 'department'],
  zonal_manager: ['zone'],
  branch_manager: ['branch'],
  dept_head: ['department'],
  employee: ['self'],
};

/**
 * The areas this role may be given at, usual one first. A custom role may use any area; "their own
 * records" and "the whole group" only for a super admin, as in the database (app.can_grant).
 */
export function areaLevelsFor(role, { isSuperAdmin = false } = {}) {
  const key = roleKeyOf(role);
  const keys = ROLE_AREAS[key] ?? ['department', 'branch', 'zone', 'entity', 'self', 'global'];
  return keys
    .filter((scopeType) => scopeType !== 'global' || isSuperAdmin)
    .filter((scopeType) => scopeType !== 'self' || key === 'employee' || isSuperAdmin)
    .map(areaLevel);
}

/**
 * Roles that exist but this person may not hand out, each with the reason in plain words — shown
 * greyed rather than silently missing. Super admin is never listed (it has its own switch).
 */
export function lockedRoles(myRank, myRoles = [], catalogue = []) {
  const ceiling = maxGrantableRank(myRank, myRoles);
  const hrCapped = ceiling === GRANT_CEILING.hr_manager && (myRoles ?? []).some((role) => roleKeyOf(role) === 'hr_manager');
  const offered = new Set(grantableRoles(myRank, myRoles, catalogue).map((role) => role.key));
  const builtIn = ROLE_PRESETS.map((preset) => ({ ...preset, catalogue: null }));
  const custom = (catalogue ?? [])
    .filter((role) => role?.key && !role.is_system && !RANK_BY_ROLE[role.key] && role.key !== 'super_admin')
    .map((role) => ({ key: role.key, rank: Number(role.rank) || 20, label: role.name || role.key, custom: true, catalogue: role }));
  return [...builtIn, ...custom]
    .filter((role) => !offered.has(role.key))
    .map((role) => {
      let reason = 'Only someone more senior than you can give this.';
      if (hrCapped) reason = 'HR can give roles up to Department Head.';
      if (role.custom && carriesAdminAuthority(role.catalogue) && myRank < 80) reason = 'It can manage users, so only a company admin can give it.';
      return { key: role.key, label: role.label, custom: Boolean(role.custom), reason };
    });
}

/** A place's name, the way people say it ("Kochi branch", "Sales department"). */
export function placeName(scopeType, id, org) {
  const level = areaLevel(scopeType);
  if (!level?.noun || !id) return null;
  const list = { department: org?.departments, branch: org?.branches, zone: org?.zones, entity: org?.entities }[scopeType] ?? [];
  const row = list.find((x) => x.id === id);
  if (!row) return null;
  const name = (scopeType === 'branch' ? row.name || row.code : row.name) ?? '';
  if (scopeType === 'entity') return name;
  return name.toLowerCase().includes(level.noun) ? name : `${name} ${level.noun}`;
}
