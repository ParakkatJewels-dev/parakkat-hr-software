import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ESS_NAV, OVERSIGHT_NAV, canSeeTab, labelForTab, visibleSections, allScreenIds, predicatesFor,
  mobilePrimarySections, MOBILE_PRIMARY_IDS, MOBILE_NAV_SLOTS,
} from './navMap.js';

// Each role's grants at its own scope, plus the employee@self grants every manager also holds
// (0096). Taken from the role_permissions table as it stands with 0099-0107 applied — the same
// query the access review ran, so if the ladder changes under us these tests say so.
const SELF_GRANTS = [
  'asset.read', 'attendance.punch', 'attendance.read', 'document.read', 'employee.read',
  'exit.create', 'expense.create', 'expense.read', 'goal.read', 'goal.update', 'leave.create',
  'leave.read', 'payslip.read', 'regularization.create', 'task.read', 'task.update',
  'ticket.create', 'ticket.read',
];

const SCOPED_GRANTS = {
  entity_admin: [
    'asset.manage', 'asset.read', 'attendance.manage', 'attendance.punch', 'attendance.read',
    'audit.read', 'device.manage', 'document.manage', 'document.read', 'employee.assign',
    'employee.create', 'employee.delete', 'employee.read', 'employee.update', 'exit.create',
    'exit.manage', 'expense.approve', 'expense.create', 'expense.read', 'goal.read', 'goal.update',
    'holiday.manage', 'leave.approve', 'leave.create', 'leave.manage', 'leave.read',
    'onboarding.manage', 'org.manage', 'payroll.manage', 'payslip.read', 'performance.manage',
    'rbac.manage', 'recruitment.manage', 'regularization.approve', 'regularization.create',
    'report.read', 'shift.manage', 'task.create', 'task.manage', 'task.read', 'task.request',
    'task.update', 'ticket.create', 'ticket.manage', 'ticket.read',
  ],
  hr_manager: [
    'asset.read', 'attendance.manage', 'attendance.punch', 'attendance.read', 'device.manage',
    'document.manage', 'document.read', 'employee.assign', 'employee.create', 'employee.read',
    'employee.update', 'exit.create', 'exit.manage', 'expense.approve', 'expense.create',
    'expense.read', 'goal.read', 'goal.update', 'holiday.manage', 'leave.approve', 'leave.create',
    'leave.manage', 'leave.read', 'onboarding.manage', 'payroll.manage', 'payslip.read',
    'performance.manage', 'rbac.manage', 'recruitment.manage', 'regularization.approve',
    'regularization.create', 'report.read', 'shift.manage', 'task.create', 'task.manage',
    'task.read', 'task.request', 'task.update', 'ticket.create', 'ticket.manage', 'ticket.read',
  ],
  // 0100 takes payslip.read and document.read off the three roles below.
  zonal_manager: [
    'asset.read', 'attendance.manage', 'attendance.punch', 'attendance.read', 'employee.assign',
    'employee.create', 'employee.read', 'employee.update', 'exit.create', 'expense.approve',
    'expense.create', 'expense.read', 'goal.read', 'goal.update', 'leave.approve', 'leave.create',
    'leave.read', 'performance.manage', 'rbac.manage', 'regularization.approve',
    'regularization.create', 'report.read', 'task.create', 'task.manage', 'task.read',
    'task.request', 'task.update', 'ticket.create', 'ticket.manage', 'ticket.read',
  ],
  branch_manager: [
    'asset.read', 'attendance.manage', 'attendance.punch', 'attendance.read', 'employee.assign',
    'employee.create', 'employee.read', 'employee.update', 'exit.create', 'expense.approve',
    'expense.create', 'expense.read', 'goal.read', 'goal.update', 'leave.approve', 'leave.create',
    'leave.read', 'performance.manage', 'rbac.manage', 'regularization.approve',
    'regularization.create', 'report.read', 'task.create', 'task.manage', 'task.read',
    'task.request', 'task.update', 'ticket.create', 'ticket.manage', 'ticket.read',
  ],
  dept_head: [
    'asset.read', 'attendance.punch', 'attendance.read', 'employee.assign', 'employee.create',
    'employee.read', 'employee.update', 'exit.create', 'expense.create', 'expense.read',
    'goal.read', 'goal.update', 'leave.approve', 'leave.create', 'leave.read',
    'performance.manage', 'rbac.manage', 'regularization.approve', 'regularization.create',
    'report.read', 'task.create', 'task.manage', 'task.read', 'task.request', 'task.update',
    'ticket.create', 'ticket.read',
  ],
};

const SCOPE_OF = {
  entity_admin: 'entity', hr_manager: 'entity', zonal_manager: 'zone',
  branch_manager: 'branch', dept_head: 'department',
};

function permsFor(role) {
  if (role === 'employee') {
    return SELF_GRANTS.map((permission) => ({ permission, scope_type: 'self', scope_id: null }));
  }
  return [
    ...SCOPED_GRANTS[role].map((permission) => ({
      permission, scope_type: SCOPE_OF[role], scope_id: `${SCOPE_OF[role]}-1`,
    })),
    ...SELF_GRANTS.map((permission) => ({ permission, scope_type: 'self', scope_id: null })),
  ];
}

const screensFor = (role) =>
  visibleSections(role, predicatesFor(permsFor(role)))
    .flatMap((section) => section.tabs.map((tab) => tab.id));

test('a plain employee gets the self-service tree and nothing from oversight', () => {
  const screens = screensFor('employee');
  for (const id of ['dashboard', 'attendance', 'leave', 'payroll', 'tasks', 'my-assets']) {
    assert.ok(screens.includes(id), `employee should see ${id}`);
  }
  // The oversight-only screens must not appear, whatever the ESS tree happens to contain.
  for (const id of ['directory', 'organization', 'reports', 'administration', 'assets']) {
    assert.ok(!screens.includes(id), `employee must NOT see ${id}`);
  }
});

test('the oversight tree drops a section when the viewer holds none of its tabs', () => {
  const deptHead = visibleSections('dept_head', predicatesFor(permsFor('dept_head')));
  const ids = deptHead.map((section) => section.id);
  // Every section a department head reaches has at least one tab in it.
  for (const section of deptHead) assert.ok(section.tabs.length > 0, `${section.id} is empty`);
  assert.ok(ids.includes('people'));
  assert.ok(ids.includes('work'));
});

test('only entity admin reaches the audit log, and structure', () => {
  for (const role of ['hr_manager', 'zonal_manager', 'branch_manager', 'dept_head', 'employee']) {
    const screens = screensFor(role);
    assert.ok(!screens.includes('admin-audit'), `${role} must not reach the audit log`);
    assert.ok(!screens.includes('organization'), `${role} must not reach Structure`);
  }
  const admin = screensFor('entity_admin');
  assert.ok(admin.includes('admin-audit'));
  assert.ok(admin.includes('organization'));
});

test('hiring, onboarding and device setup stop at HR', () => {
  for (const role of ['zonal_manager', 'branch_manager', 'dept_head']) {
    const screens = screensFor(role);
    for (const id of ['recruitment', 'onboarding', 'attendance-admin']) {
      assert.ok(!screens.includes(id), `${role} must not reach ${id}`);
    }
  }
  const hr = screensFor('hr_manager');
  for (const id of ['recruitment', 'onboarding', 'attendance-admin']) {
    assert.ok(hr.includes(id), `hr_manager should reach ${id}`);
  }
});

test('a scoped tab needs the permission beyond self scope', () => {
  const selfOnly = predicatesFor([
    { permission: 'employee.read', scope_type: 'self', scope_id: null },
  ]);
  assert.equal(canSeeTab({ id: 'directory', perm: 'employee.read', scoped: true }, selfOnly), false);
  assert.equal(canSeeTab({ id: 'x', perm: 'employee.read' }, selfOnly), true);
});

test('a screen serving two audiences is named for the one reading it', () => {
  const payroll = OVERSIGHT_NAV
    .find((s) => s.id === 'pay').tabs.find((t) => t.id === 'payroll');

  const hrView = predicatesFor(permsFor('hr_manager'));
  assert.equal(labelForTab(payroll, hrView), 'Payroll');

  // After 0100 a department head holds payslip.read at self scope only — so the screen is theirs,
  // and says so, rather than promising a company-wide view it will not show.
  const headView = predicatesFor(permsFor('dept_head'));
  assert.equal(labelForTab(payroll, headView), 'My Payslips');
});

test('a tab with no permission is visible to everyone', () => {
  const nobody = predicatesFor([]);
  assert.equal(canSeeTab({ id: 'settings', perm: null }, nobody), true);
  assert.ok(screensFor('employee').includes('settings'));
});

test('a super admin sees every section in the oversight tree', () => {
  const god = predicatesFor([], { isSuperAdmin: true });
  const ids = visibleSections('entity_admin', god).map((s) => s.id);
  assert.deepEqual(ids, OVERSIGHT_NAV.map((s) => s.id));
});

test('every screen id is unique within a tree, and known ids cover both trees', () => {
  const ess = ESS_NAV.flatMap((g) => g.items.map((i) => i.id));
  assert.equal(new Set(ess).size, ess.length, 'duplicate id in the ESS tree');

  const known = allScreenIds();
  for (const id of ess) assert.ok(known.includes(id));
  for (const section of OVERSIGHT_NAV) {
    for (const tab of section.tabs) assert.ok(known.includes(tab.id), `${tab.id} missing`);
  }
});

test('predicatesFor reads a permission list the same way the signed-in session does', () => {
  const list = [
    { permission: 'task.read', scope_type: 'department', scope_id: 'd1' },
    { permission: 'payslip.read', scope_type: 'self', scope_id: null },
  ];
  const p = predicatesFor(list);
  assert.equal(p.canAny('task.read'), true);
  assert.equal(p.canBeyondSelf('task.read'), true);
  assert.equal(p.canAny('payslip.read'), true);
  assert.equal(p.canBeyondSelf('payslip.read'), false, 'a self grant is not oversight');
  assert.equal(p.canAny('org.manage'), false);
});

// ---- per-user screen overrides (migration 0109) -----------------------------------------------

test('a hidden screen leaves the sidebar without touching the rest', () => {
  const before = screensFor('dept_head');
  assert.ok(before.includes('employee-import'), 'precondition: heads reach Import today');

  const after = visibleSections(
    'dept_head',
    predicatesFor(permsFor('dept_head'), { hiddenScreens: ['employee-import'] })
  ).flatMap((s) => s.tabs.map((t) => t.id));

  assert.ok(!after.includes('employee-import'), 'Import should be gone');
  assert.deepEqual(
    after,
    before.filter((id) => id !== 'employee-import'),
    'nothing else should move'
  );
});

test('hiding every tab in a section drops the section entirely', () => {
  const sections = visibleSections(
    'entity_admin',
    predicatesFor(permsFor('entity_admin'), {
      hiddenScreens: ['administration', 'admin-roles', 'admin-audit'],
    })
  );
  assert.ok(!sections.some((s) => s.id === 'admin'), 'an empty Administration must not render');
});

test('an override narrows and never widens', () => {
  // A department head does not reach Structure. Naming it in the override list must not grant it.
  const screens = visibleSections(
    'dept_head',
    predicatesFor(permsFor('dept_head'), { hiddenScreens: ['organization'] })
  ).flatMap((s) => s.tabs.map((t) => t.id));
  assert.ok(!screens.includes('organization'));
});

test('a super admin is never narrowed, so the account that can undo it stays able to', () => {
  const p = predicatesFor([], { isSuperAdmin: true, hiddenScreens: ['administration'] });
  assert.equal(p.hidden.size, 0);
  const screens = visibleSections('entity_admin', p).flatMap((s) => s.tabs.map((t) => t.id));
  assert.ok(screens.includes('administration'), 'a super admin keeps Users & Access');
});

test('the route guard refuses a hidden screen, not just the menu', () => {
  const p = predicatesFor(permsFor('dept_head'), { hiddenScreens: ['employee-import'] });
  const importTab = OVERSIGHT_NAV
    .find((s) => s.id === 'people').tabs.find((t) => t.id === 'employee-import');
  assert.equal(canSeeTab(importTab, p), false, 'typing the URL must not work either');
});

test('canSeeTab takes a Set or a plain array', () => {
  const tab = { id: 'reports', perm: null };
  assert.equal(canSeeTab(tab, { hidden: new Set(['reports']) }), false);
  assert.equal(canSeeTab(tab, { hidden: ['reports'] }), false);
  assert.equal(canSeeTab(tab, { hidden: new Set() }), true);
  assert.equal(canSeeTab(tab, {}), true, 'no override list at all is not an override');
});

// ---- the phone's bottom bar --------------------------------------------------------------------
//
// On a phone the bar IS the navigation — four seats, and everything else is behind More. These
// tests exist because the seats used to be decided by `sections.slice(0, 4)`, so a row moved in the
// sidebar rearranged them silently, and the four went to what an employee opens monthly rather than
// daily. If somebody reorders a tree again, these say so rather than the users noticing.

const barFor = (role) =>
  mobilePrimarySections(
    visibleSections(role, predicatesFor(permsFor(role))),
    role
  ).map((section) => section.id);

test('an employee gets work on the bottom bar, not payslips', () => {
  const bar = barFor('employee');
  assert.deepEqual(bar, ['dashboard', 'tasks', 'attendance', 'leave']);
  assert.ok(!bar.includes('payroll'), 'Pay is opened monthly and does not hold a seat');
});

test('a manager reaches Work without opening More', () => {
  for (const role of ['entity_admin', 'hr_manager', 'branch_manager', 'dept_head']) {
    const bar = barFor(role);
    assert.ok(bar.includes('work'), `${role} should reach Work from the bar`);
    assert.equal(bar[0], 'home');
    assert.equal(bar[1], 'work', `${role} should have Work seated second`);
  }
});

test('the bar never seats more than it has room for, nor renders short', () => {
  for (const role of ['employee', 'entity_admin', 'dept_head']) {
    const bar = barFor(role);
    assert.equal(bar.length, MOBILE_NAV_SLOTS, `${role} should fill the bar`);
    assert.equal(new Set(bar).size, bar.length, `${role} has a section seated twice`);
  }
});

test('a section the viewer cannot see is skipped, and the bar tops up from tree order', () => {
  // No task.read at all: Tasks leaves the tree, so its seat goes to the next section rather than
  // leaving a gap or shrinking the bar to three.
  const noTasks = permsFor('employee').filter((p) => p.permission !== 'task.read');
  const sections = visibleSections('employee', predicatesFor(noTasks));
  const bar = mobilePrimarySections(sections, 'employee').map((s) => s.id);

  assert.ok(!bar.includes('tasks'));
  assert.equal(bar.length, MOBILE_NAV_SLOTS);
  assert.deepEqual(bar.slice(0, 3), ['dashboard', 'attendance', 'leave'], 'stated order holds');
});

test('every section the bar names is a real one in its tree', () => {
  const essIds = ESS_NAV.flatMap((g) => g.items.map((i) => i.id));
  for (const id of MOBILE_PRIMARY_IDS.employee) {
    assert.ok(essIds.includes(id), `${id} is not a screen in the ESS tree`);
  }
  const oversightIds = OVERSIGHT_NAV.map((s) => s.id);
  for (const id of MOBILE_PRIMARY_IDS.oversight) {
    assert.ok(oversightIds.includes(id), `${id} is not a section in the oversight tree`);
  }
});

test('an employee section carries the drawer heading it belongs under', () => {
  const sections = visibleSections('employee', predicatesFor(permsFor('employee')));
  const titles = ESS_NAV.map((g) => g.title);
  for (const section of sections) {
    assert.ok(titles.includes(section.group), `${section.id} has no drawer heading`);
  }
  assert.equal(sections.find((s) => s.id === 'tasks').group, 'Work');
  assert.equal(sections.find((s) => s.id === 'payroll').group, 'Me');
});
