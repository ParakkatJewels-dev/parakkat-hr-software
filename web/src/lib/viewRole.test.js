// Working "as an employee" has to reach the screens, not just the sidebar.
//
//   node --test src/lib/viewRole.test.js
//
// The first switcher passed the chosen role to the sidebar and the Dashboard preset and nothing
// else, so an HR manager who picked Employee got ESS labels — "My Payslips", "My Leave" — over
// screens still rendering the whole branch. Every screen gates on the helpers in usePermissions, so
// the lens is applied there: narrow the grants to the self-scoped ones and every existing gate
// follows. These pin that narrowing, and the two rules that keep it honest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { hasPerm, applyViewLens } from './permissionMatch.js';
import { useViewRole } from './viewRole.js';

// What an hr_manager@entity actually carries — including the employee@self grant that
// app.tg_autogrant_ess adds automatically, which is why the lens has something to fall back to.
const HR_MANAGER = [
  { permission: 'payroll.manage', scope_type: 'entity', scope_id: 'ent-1' },
  { permission: 'leave.approve', scope_type: 'entity', scope_id: 'ent-1' },
  { permission: 'employee.read', scope_type: 'entity', scope_id: 'ent-1' },
  { permission: 'document.manage', scope_type: 'entity', scope_id: 'ent-1' },
  { permission: 'task.create', scope_type: 'entity', scope_id: 'ent-1' },
  { permission: 'leave.read', scope_type: 'entity', scope_id: 'ent-1' },
  { permission: 'leave.read', scope_type: 'self', scope_id: null },
  { permission: 'payslip.read', scope_type: 'self', scope_id: null },
  { permission: 'employee.read', scope_type: 'self', scope_id: null },
];

// THE REAL FUNCTION, imported. The first version of this file reimplemented the narrowing here,
// which meant the tests agreed with a copy of the rule and could not fail when the code broke —
// and they did not, when a rename left `subscribe is not defined` in viewRole.js and the app
// crashed on load with all 143 green.
const lens = (list, viewingAsEmployee) =>
  applyViewLens(list, { chosenRole: viewingAsEmployee ? 'employee' : null }).list;

const canAny = (list, perm) => list.some((p) => p.permission === perm);
const canBeyondSelf = (list, perm) =>
  list.some((p) => p.permission === perm && p.scope_type !== 'self');

test('the view-role hook can render with its external-store subscription', () => {
  function Probe() {
    const [role] = useViewRole('hr_manager', ['hr_manager', 'employee']);
    return createElement('span', null, role);
  }

  assert.equal(renderToStaticMarkup(createElement(Probe)), '<span>hr_manager</span>');
});

test('as themselves, an HR manager keeps every manager gate', () => {
  const l = lens(HR_MANAGER, false);
  assert.equal(canAny(l, 'payroll.manage'), true, 'Payroll keeps its manager tabs');
  assert.equal(canAny(l, 'task.create'), true, 'New Task is offered');
  assert.equal(canBeyondSelf(l, 'employee.read'), true, 'Directory is reachable');
  assert.equal(canBeyondSelf(l, 'leave.read'), true, 'the Mine/Everyone toggle is offered');
});

// The reported bug, in one assertion per screen the user named.
test('working as an employee closes every manager gate', () => {
  const l = lens(HR_MANAGER, true);
  assert.equal(canAny(l, 'payroll.manage'), false, 'Payroll drops Run/Salary/Deductions');
  assert.equal(canAny(l, 'task.create'), false, 'New Task disappears');
  assert.equal(canAny(l, 'document.manage'), false, 'the document library loses its controls');
  assert.equal(canAny(l, 'leave.approve'), false, 'no approve dropdowns');
  assert.equal(canBeyondSelf(l, 'employee.read'), false, 'Directory refuses the route');
});

// Hiding the controls is only half of it: RLS still returns the branch's rows, because the database
// answers to the account and not to a toggle. This is the predicate the lists narrow on.
test('a narrowed viewer is told to show only their own rows', () => {
  const asManager = lens(HR_MANAGER, false);
  const asEmployee = lens(HR_MANAGER, true);
  assert.equal(canBeyondSelf(asManager, 'leave.read'), true, 'manager may choose Everyone');
  assert.equal(canBeyondSelf(asEmployee, 'leave.read'), false, 'employee view is forced to Mine');
});

test('the self grants survive — the point is to be an employee, not to be locked out', () => {
  const l = lens(HR_MANAGER, true);
  assert.equal(canAny(l, 'payslip.read'), true, 'My Payslips still opens');
  assert.equal(canAny(l, 'leave.read'), true, 'My Leave still opens');
  assert.equal(
    hasPerm(l, 'leave.read', { employeeId: 'me' }, { isSuperAdmin: false, myEmployeeId: 'me' }),
    true,
    'and still resolves to their own record'
  );
});

// A super admin bypasses every check inside hasPerm, so narrowing the list alone would leave them
// seeing everything while the app claimed they were an employee.
test('a super admin in employee view is not still a super admin', () => {
  const { list: asEmployee, effectiveSuperAdmin, viewingAsEmployee } =
    applyViewLens([], { isSuperAdmin: true, chosenRole: 'employee' });
  assert.equal(viewingAsEmployee, true, 'a super admin always holds more than self');
  assert.equal(effectiveSuperAdmin, false, 'the bypass is dropped with the grants');
  assert.equal(
    hasPerm(asEmployee, 'payroll.manage', {}, { isSuperAdmin: effectiveSuperAdmin, myEmployeeId: 'me' }),
    false,
    'the super-admin bypass must be dropped with the grants'
  );
  assert.equal(
    hasPerm([], 'payroll.manage', {}, { isSuperAdmin: true, myEmployeeId: 'me' }),
    true,
    'control: the bypass is real, so the assertion above is meaningful'
  );
});

// A plain employee has nothing to set aside, so the lens must be a no-op for them rather than
// stripping the grants they already have.
test('a plain employee is unaffected', () => {
  const EMPLOYEE = [
    { permission: 'leave.read', scope_type: 'self', scope_id: null },
    { permission: 'payslip.read', scope_type: 'self', scope_id: null },
  ];
  assert.deepEqual(lens(EMPLOYEE, true), EMPLOYEE);
  assert.deepEqual(lens(EMPLOYEE, false), EMPLOYEE);
});
