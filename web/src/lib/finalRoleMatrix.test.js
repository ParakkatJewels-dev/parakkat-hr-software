import test from 'node:test';
import assert from 'node:assert/strict';
import { hasPerm, applyViewLens } from './permissionMatch.js';
import { resolvePrimaryRole, ROLE_PRIORITY } from './roles.js';
import { grantableRoles, maxGrantableRank, ROLE_PRESETS } from './roleGrants.js';

const SCOPE_BY_ROLE = {
  entity_admin: 'entity',
  hr_manager: 'entity',
  zonal_manager: 'zone',
  branch_manager: 'branch',
  dept_head: 'department',
  employee: 'self',
};

const RANK_BY_ROLE = {
  super_admin: 1000,
  entity_admin: 80,
  hr_manager: 60,
  zonal_manager: 50,
  branch_manager: 40,
  dept_head: 30,
  employee: 10,
};

const ROLE_COMBOS = [
  ['super_admin'],
  ['entity_admin', 'employee'],
  ['hr_manager', 'employee'],
  ['zonal_manager', 'employee'],
  ['branch_manager', 'employee'],
  ['dept_head', 'employee'],
  ['employee'],
  ['entity_admin', 'hr_manager', 'employee'],
  ['hr_manager', 'zonal_manager', 'employee'],
  ['hr_manager', 'dept_head', 'employee'],
  ['zonal_manager', 'branch_manager', 'employee'],
  ['branch_manager', 'dept_head', 'employee'],
  ['dept_head', 'employee', 'employee'],
];

function scopeFor(index) {
  return {
    entityId: `entity-${index % 4}`,
    zoneId: `zone-${index % 6}`,
    branchId: `branch-${index % 12}`,
    deptId: `dept-${index % 20}`,
    employeeId: `employee-${index}`,
  };
}

function permissionForRole(role, index) {
  const scope = scopeFor(index);
  const scopeType = SCOPE_BY_ROLE[role];
  const scopeId = {
    entity: scope.entityId,
    zone: scope.zoneId,
    branch: scope.branchId,
    department: scope.deptId,
    self: null,
  }[scopeType];

  return {
    permission: role === 'employee' ? 'leave.create' : 'employee.create',
    scope_type: scopeType,
    scope_id: scopeId,
  };
}

function actor(index) {
  const roles = ROLE_COMBOS[index % ROLE_COMBOS.length];
  const isSuperAdmin = roles.includes('super_admin');
  const assignedRoles = roles.filter((role) => role !== 'super_admin');
  const employeeId = `employee-${index}`;
  const permissions = assignedRoles.map((role) => permissionForRole(role, index));

  if (assignedRoles.some((role) => role !== 'employee') && !assignedRoles.includes('employee')) {
    permissions.push({ permission: 'leave.create', scope_type: 'self', scope_id: null });
  }

  return {
    id: index,
    roles,
    assignments: assignedRoles.map((role) => ({ role })),
    isSuperAdmin,
    myRank: isSuperAdmin ? 1000 : Math.max(...assignedRoles.map((role) => RANK_BY_ROLE[role])),
    employeeId,
    scope: scopeFor(index),
    permissions,
  };
}

const ACTORS = Array.from({ length: 200 }, (_, index) => actor(index));

test('final matrix covers 200 actor entries, every role, and repeated multi-role users', () => {
  assert.equal(ACTORS.length, 200);

  const seenRoles = new Set(ACTORS.flatMap((a) => a.roles));
  assert.deepEqual([...seenRoles].sort(), [...ROLE_PRIORITY].sort());

  for (const role of ROLE_PRIORITY) {
    assert.ok(
      ACTORS.filter((a) => a.roles.includes(role)).length > 1,
      `${role} should appear in multiple actor entries`
    );
  }

  assert.ok(ACTORS.filter((a) => a.roles.length > 1).length > 100);
});

test('final matrix resolves each actor to the highest role they hold', () => {
  for (const a of ACTORS) {
    const expected = ROLE_PRIORITY.find((role) => a.roles.includes(role));
    assert.equal(resolvePrimaryRole(a.assignments, a.isSuperAdmin), expected, `actor ${a.id}`);
  }
});

test('final matrix validates scoped permission matching for every non-super actor', () => {
  for (const a of ACTORS.filter((entry) => !entry.isSuperAdmin)) {
    assert.equal(
      hasPerm(a.permissions, 'leave.create', { employeeId: a.employeeId }, { myEmployeeId: a.employeeId }),
      a.roles.includes('employee'),
      `actor ${a.id} self-service access`
    );

    if (!a.roles.some((role) => role !== 'employee')) continue;

    assert.equal(
      hasPerm(a.permissions, 'employee.create', a.scope, { myEmployeeId: a.employeeId }),
      true,
      `actor ${a.id} scoped employee.create`
    );
    assert.equal(
      hasPerm(
        a.permissions,
        'employee.create',
        { ...a.scope, entityId: 'other-entity', zoneId: 'other-zone', branchId: 'other-branch', deptId: 'other-dept' },
        { myEmployeeId: a.employeeId }
      ),
      false,
      `actor ${a.id} must not cross scope`
    );
  }
}
);

test('final matrix validates employee view lens for managers and super admins', () => {
  for (const a of ACTORS) {
    const lens = applyViewLens(a.permissions, {
      isSuperAdmin: a.isSuperAdmin,
      chosenRole: 'employee',
    });
    const shouldNarrow = a.isSuperAdmin || a.permissions.some((p) => p.scope_type !== 'self');

    assert.equal(lens.viewingAsEmployee, shouldNarrow, `actor ${a.id}`);
    assert.equal(lens.effectiveSuperAdmin, shouldNarrow ? false : a.isSuperAdmin, `actor ${a.id}`);
    if (shouldNarrow) {
      assert.ok(lens.list.every((p) => p.scope_type === 'self'), `actor ${a.id}`);
    } else {
      assert.deepEqual(lens.list, a.permissions, `actor ${a.id}`);
    }
  }
});

test('final matrix validates grant ceilings across repeated role combinations', () => {
  const presetRanks = Object.fromEntries(ROLE_PRESETS.map((role) => [role.key, role.rank]));

  for (const a of ACTORS) {
    const options = grantableRoles(a.myRank, a.roles);
    const ceiling = maxGrantableRank(a.myRank, a.roles);
    assert.ok(options.every((role) => role.rank <= ceiling), `actor ${a.id}`);
    assert.ok(options.every((role) => role.key !== 'super_admin'), `actor ${a.id}`);

    if (a.roles.includes('hr_manager') && !a.roles.includes('entity_admin')) {
      assert.deepEqual(options.map((role) => role.key), ['employee', 'dept_head'], `actor ${a.id}`);
    }
    if (a.roles.includes('entity_admin')) {
      assert.ok(options.some((role) => role.key === 'hr_manager'), `actor ${a.id}`);
      assert.ok(!options.some((role) => presetRanks[role.key] >= presetRanks.entity_admin), `actor ${a.id}`);
    }
    if (a.isSuperAdmin) {
      assert.deepEqual(options.map((role) => role.key), ROLE_PRESETS.map((role) => role.key), `actor ${a.id}`);
    }
  }
});
