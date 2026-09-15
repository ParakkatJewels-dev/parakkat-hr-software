import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import React from 'react';
import { transformWithOxc } from 'vite';
import { hasPerm } from '../lib/permissionMatch.js';

// Drive the real component's event handlers without a DOM dependency. Only its hook state and
// external boundaries are substituted; selection, validation and payload construction stay real.
const sourceUrl = new URL('./GoalForm.jsx', import.meta.url);
const { code } = await transformWithOxc(await readFile(sourceUrl, 'utf8'), sourceUrl.pathname,
  { jsx: { runtime: 'automatic' } });
const stubs = {
  react: 'export const useId = () => "goal-test"; export const useState = value => globalThis.goalFormHarness.useState(value);',
  'lucide-react': 'export const Target = "goal-icon";',
  '../auth/AuthContext': 'export const useAuth = () => globalThis.goalFormHarness.auth;',
  '../auth/usePermissions': 'export const usePermissions = () => globalThis.goalFormHarness.permissions;',
  '../data/employees': 'export const useEmployees = options => { globalThis.goalFormHarness.employeeQueryOptions = options; return globalThis.goalFormHarness.people; };',
  '../data/goals': 'export const useSaveGoal = () => globalThis.goalFormHarness.save;',
  './ui/FormSection': 'export default "goal-form-section"; export const Field = "goal-field";',
  './GoalEmployeePicker': 'export default "goal-employee-picker";',
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === sourceUrl.href && stubs[specifier]) {
      return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === sourceUrl.href) return { format: 'module', source: code, shortCircuit: true };
    return next(url, context);
  },
});
const { default: GoalForm } = await import(sourceUrl.href);
after(() => { hooks.deregister(); delete globalThis.goalFormHarness; });

const person = (id, overrides = {}) => ({ id, full_name: `${id} employee`, status: 'Active',
  entity_id: 'company', zone_id: 'zone', branch_id: 'branch', department_id: 'department', ...overrides });
const roster = [person('self'), person('active'), person('inactive', { status: 'Inactive' }),
  person('readable-only', { department_id: 'other-department' }),
  person('foreign', { entity_id: 'other-company', zone_id: 'other-zone', branch_id: 'other-branch', department_id: 'foreign-department' })];

function find(element, predicate) {
  if (!React.isValidElement(element)) return null;
  if (predicate(element)) return element;
  for (const child of React.Children.toArray(element.props.children)) {
    const match = find(child, predicate);
    if (match) return match;
  }
  return null;
}

function mount() {
  const slots = [];
  let cursor = 0;
  const writes = [], created = [], closed = [];
  const harness = {
    auth: { employee: roster[0] },
    grants: [
      { permission: 'performance.manage', scope_type: 'department', scope_id: 'department' },
      { permission: 'employee.read', scope_type: 'entity', scope_id: 'company' },
    ],
    people: { data: roster, isLoading: false, error: null, refetch() {} },
    save: { isPending: false, error: null, async mutateAsync(payload) { writes.push(payload); return { id: 'saved-goal' }; } },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
  };
  harness.permissions = {
    viewingAsEmployee: false,
    canAny: permission => harness.grants.some(grant => grant.permission === permission),
    can: (permission, scope) => hasPerm(harness.grants, permission, scope, { myEmployeeId: harness.auth.employee?.id }),
  };
  const render = () => {
    globalThis.goalFormHarness = harness;
    cursor = 0;
    return GoalForm({ onClose: () => closed.push(true), onCreated: result => created.push(result) });
  };
  const picker = () => find(render(), element => element.type === 'goal-employee-picker');
  const input = label => {
    const field = find(render(), element => element.type === 'goal-field' && element.props.label === label);
    assert.ok(field, `Missing field: ${label}`);
    return find(field, element => element.type === 'input' || element.type === 'textarea');
  };
  return { harness, writes, created, closed, render, picker, input,
    choose: id => picker().props.onChange(id),
    fill: (label, value) => input(label).props.onChange({ target: { value } }),
    async submit() {
      let prevented = false;
      await render().props.onSubmit({ preventDefault() { prevented = true; } });
      assert.equal(prevented, true);
    },
  };
}

test('the candidate roster follows goal-management scope, retaining self and inactive employees', () => {
  const form = mount();
  assert.equal(form.harness.permissions.can('employee.read', { entityId: 'company', employeeId: 'readable-only' }), true);
  assert.deepEqual(form.picker().props.employees.map(employee => employee.id), ['self', 'active', 'inactive']);
  assert.equal(form.harness.employeeQueryOptions.enabled, true);
  form.harness.grants = [{ permission: 'performance.manage', scope_type: 'self' }];
  assert.deepEqual(form.picker().props.employees.map(employee => employee.id), ['self']);
});

test('employee presentation and accounts without management permission do not expose the form', () => {
  const form = mount();
  form.harness.permissions.viewingAsEmployee = true;
  assert.equal(form.harness.permissions.canAny('performance.manage'), true);
  assert.equal(form.render(), null);
  assert.equal(form.harness.employeeQueryOptions.enabled, false);
  form.harness.permissions.viewingAsEmployee = false;
  form.harness.grants = [{ permission: 'employee.read', scope_type: 'entity', scope_id: 'company' }];
  assert.equal(form.render(), null);
  assert.equal(form.harness.employeeQueryOptions.enabled, false);
});

test('a nonblank title and a currently eligible selection are required even for direct submit events', async () => {
  const form = mount();
  form.fill('Goal title', 'Measure stock accuracy');
  assert.equal(form.render().props.disabled, true);
  await form.submit();
  form.choose('readable-only');
  assert.equal(form.render().props.disabled, true);
  await form.submit();
  form.choose('active');
  form.fill('Goal title', ' \n\t ');
  assert.equal(form.render().props.disabled, true);
  await form.submit();
  form.fill('Goal title', 'Measure stock accuracy');
  assert.equal(form.render().props.disabled, false);
  form.choose('');
  await form.submit();
  assert.deepEqual(form.writes, []);
});

test('roster failures, permission changes and removed employees invalidate an existing selection', async () => {
  const form = mount();
  form.choose('active');
  form.fill('Goal title', 'Audit stock');
  for (const state of [{ isLoading: true }, { error: new Error('Roster unavailable') },
    { data: roster.filter(employee => employee.id !== 'active') }]) {
    const original = form.harness.people;
    form.harness.people = { ...original, ...state };
    assert.equal(form.render().props.disabled, true);
    await form.submit();
    form.harness.people = original;
  }
  form.harness.grants = [{ permission: 'performance.manage', scope_type: 'department', scope_id: 'other-department' }];
  assert.equal(form.render().props.disabled, true);
  await form.submit();
  assert.deepEqual(form.writes, []);
});

test('submission trims text, preserves an optional target date and reports the saved employee', async () => {
  const form = mount();
  form.choose('inactive');
  form.fill('Goal title', '  Review historical stock accuracy  ');
  form.fill('Details (optional)', '\n Measure against the agreed register. \t');
  form.fill('Target date (optional)', '2026-01-10');
  await form.submit();
  assert.deepEqual(form.writes, [{ employee_id: 'inactive', title: 'Review historical stock accuracy',
    description: 'Measure against the agreed register.', target_date: '2026-01-10', created_by: 'self' }]);
  assert.deepEqual(form.created, [{ id: 'saved-goal', employeeId: 'inactive', employeeName: 'inactive employee' }]);
});

test('blank optional details and date are null and an unlinked manager has no employee author', async () => {
  const form = mount();
  form.harness.auth.employee = null;
  form.choose('active');
  form.fill('Goal title', '  Audit stock  ');
  form.fill('Details (optional)', '\n\t ');
  await form.submit();
  assert.deepEqual(form.writes, [{ employee_id: 'active', title: 'Audit stock', description: null,
    target_date: null, created_by: null }]);
});

test('failed saves keep the chosen employee and entered details for a successful retry', async () => {
  const form = mount();
  form.choose('active');
  form.fill('Goal title', '  Audit stock  ');
  form.fill('Details (optional)', '  Count all shelves.  ');
  form.fill('Target date (optional)', '2026-10-01');
  const save = form.harness.save.mutateAsync;
  form.harness.save.mutateAsync = async payload => {
    form.writes.push(payload);
    form.harness.save.error = new Error('Connection lost. Try again.');
    throw form.harness.save.error;
  };
  await form.submit();
  assert.equal(form.render().props.error, 'Connection lost. Try again.');
  assert.equal(form.picker().props.value, 'active');
  assert.equal(form.input('Goal title').props.value, '  Audit stock  ');
  assert.equal(form.input('Details (optional)').props.value, '  Count all shelves.  ');
  assert.equal(form.input('Target date (optional)').props.value, '2026-10-01');
  assert.deepEqual(form.created, []);
  assert.deepEqual(form.closed, []);
  form.harness.save.error = null;
  form.harness.save.mutateAsync = save;
  await form.submit();
  assert.deepEqual(form.writes[1], form.writes[0]);
  assert.equal(form.created.length, 1);
});

test('a pending save disables editing and closing and ignores another submit', async () => {
  const form = mount();
  form.choose('active');
  form.fill('Goal title', 'Audit stock');
  form.harness.save.isPending = true;
  const tree = form.render();
  assert.equal(tree.props.busy, true);
  assert.equal(tree.props.onClose, undefined);
  assert.equal(form.picker().props.disabled, true);
  assert.equal(find(tree, element => element.type === 'fieldset').props.disabled, true);
  await form.submit();
  assert.deepEqual(form.writes, []);
  assert.deepEqual(form.created, []);
});
