// Narrowing the org hierarchy to what one person's grants actually cover.
//
// Every company / branch / department picker in the app is filled from one unscoped read (see
// data/org.js), and the org tables are readable by any signed-in user — entities_read is
// `using (true)` in migration 0007. So a manager scoped to one branch was offered all four
// companies and all 48 branches in every placement dropdown and every filter.
//
// WHAT THIS DOES AND DOES NOT FIX
// It stops the interface offering choices that are not the caller's. It does NOT stop the rows
// arriving — the query still returns them and devtools would still show them. Closing that means
// tightening RLS on the org tables themselves, which is a migration and a riskier one: Structure
// legitimately needs the whole tree, and getting it wrong empties every placement dropdown in the
// app. This is the honest half that can be done safely from here.
//
// No imports on purpose: the test runner cannot load anything that reaches Supabase.

/** A grant covering everything — global scope, or super admin. */
const isUnlimited = (grants, isSuperAdmin) =>
  Boolean(isSuperAdmin) || (grants ?? []).some((g) => g?.scope_type === 'global');

/**
 * The org tree as this caller should see it.
 *
 * A grant cascades DOWNWARD and not up: an entity grant covers that company's zones, branches and
 * departments; a branch grant covers that branch's departments but tells you nothing about the
 * company as a whole beyond the one entity row you need to label it.
 *
 * @param org  { entities, zones, branches, departments, designations }
 * @param grants  role assignments: [{ scope_type, scope_id }]
 */
export function visibleOrg(org, grants, isSuperAdmin = false) {
  if (!org) return org;
  if (isUnlimited(grants, isSuperAdmin)) return org;

  const at = (type) => new Set((grants ?? []).filter((g) => g?.scope_type === type).map((g) => g?.scope_id).filter(Boolean));
  const grantedEntities = at('entity');
  const grantedZones = at('zone');
  const grantedBranches = at('branch');
  const grantedDepts = at('department');

  // Nothing but self-scope: no placement is theirs to choose. An empty tree is the correct answer
  // — better than silently handing back the whole group.
  if (!grantedEntities.size && !grantedZones.size && !grantedBranches.size && !grantedDepts.size) {
    return { entities: [], zones: [], branches: [], departments: [], designations: org.designations ?? [] };
  }

  const zones = (org.zones ?? []).filter(
    (z) => grantedZones.has(z.id) || grantedEntities.has(z.entity_id),
  );
  const zoneIds = new Set(zones.map((z) => z.id));

  const branches = (org.branches ?? []).filter(
    (b) => grantedBranches.has(b.id) || grantedEntities.has(b.entity_id) || zoneIds.has(b.zone_id),
  );
  const branchIds = new Set(branches.map((b) => b.id));

  const departments = (org.departments ?? []).filter(
    (d) => grantedDepts.has(d.id) || branchIds.has(d.branch_id) || grantedEntities.has(d.entity_id),
  );

  // A company stays visible if it is granted outright, or if anything inside it is — otherwise the
  // branch you may edit would have no company to sit under and the form could not be filled in.
  const impliedEntities = new Set([
    ...grantedEntities,
    ...zones.map((z) => z.entity_id),
    ...branches.map((b) => b.entity_id),
    ...departments.map((d) => d.entity_id),
  ].filter(Boolean));

  return {
    entities: (org.entities ?? []).filter((e) => impliedEntities.has(e.id)),
    zones,
    branches,
    departments,
    // Job titles are a company-wide vocabulary, not a place. Narrowing them would stop a branch
    // manager filing somebody as "Sales Executive" because the title was created elsewhere.
    designations: org.designations ?? [],
  };
}
