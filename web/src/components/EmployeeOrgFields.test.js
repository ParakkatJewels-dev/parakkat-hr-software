import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import React from 'react';
import { transformWithOxc } from 'vite';
import { visibleOrg } from '../lib/orgScope.js';
import { hasPerm } from '../lib/permissionMatch.js';

const target = new URL('./EmployeeOrgFields.jsx', import.meta.url);
const { code } = await transformWithOxc(await readFile(target, 'utf8'), target.pathname, { jsx: { runtime: 'automatic' } });
const loader = registerHooks({ load(url, context, next) {
  return url === target.href ? { source: code, format: 'module', shortCircuit: true } : next(url, context);
} });
const { EmployeeOrgFields } = await import(target.href);
after(() => loader.deregister());

const org = {
  entities: [{ id: 'company', name: 'Company' }, { id: 'other', name: 'Other' }],
  branches: [
    { id: 'main', entity_id: 'company', name: 'Main', code: 'MAIN' },
    { id: 'north', entity_id: 'company', name: 'North', code: 'NORTH' },
    { id: 'foreign', entity_id: 'other', name: 'Foreign' },
  ],
  departments: [
    { id: 'sales', entity_id: 'company', branch_id: 'main', name: 'Sales' },
    { id: 'production', entity_id: 'company', branch_id: 'north', name: 'Production' },
    { id: 'central', entity_id: 'company', branch_id: null, name: 'Central' },
    { id: 'foreign-dept', entity_id: 'other', branch_id: 'foreign', name: 'Other department' },
    { id: 'inactive-dept', entity_id: 'company', branch_id: 'main', name: 'Inactive', is_active: false },
  ],
  designations: [
    { id: 'shared', entity_id: null, department_id: null, title: 'Shared title' },
    { id: 'company-title', entity_id: 'company', department_id: null, title: 'Company title' },
    { id: 'sales-title', entity_id: 'company', department_id: 'sales', title: 'Sales title' },
    { id: 'production-title', entity_id: 'company', department_id: 'production', title: 'Production title' },
    { id: 'foreign-title', entity_id: 'other', department_id: null, title: 'Other title' },
    { id: 'foreign-parent', entity_id: 'other', department_id: 'sales', title: 'Wrong company ancestry' },
    { id: 'inactive-title', entity_id: 'company', department_id: null, title: 'Inactive title', is_active: false },
  ],
};
function find(node, predicate) {
  if (!React.isValidElement(node)) return null;
  if (predicate(node)) return node;
  for (const child of React.Children.toArray(node.props.children)) { const match = find(child, predicate); if (match) return match; }
  return null;
}
function mount(visible = org, initial = {}) {
  const form = { value: { entity_id: 'company', branch_id: '', department_id: '', designation_id: '', ...initial }, writes: [],
    render() { return EmployeeOrgFields({ org: visible, value: this.value, onChange: patch => { this.writes.push(patch); this.value = { ...this.value, ...patch }; } }); },
    field(id) { return find(this.render(), node => node.props.id === `org-${id}`); },
    options(id) { return React.Children.toArray(this.field(id).props.children).filter(React.isValidElement).map(node => node.props.value); },
    change(id, value) { this.field(id).props.onChange({ target: { value } }); },
  };
  return form;
}

test('selecting a branch department fills its branch and resets a stale designation', () => {
  const form = mount(org, { designation_id: 'company-title' });
  assert.deepEqual(form.options('department'), ['', 'sales', 'production', 'central']);
  form.change('department', 'sales');
  assert.deepEqual(form.writes, [{ department_id: 'sales', designation_id: '', branch_id: 'main' }]);
  assert.equal(form.field('branch').props.value, 'main');
  assert.deepEqual(form.options('department'), ['', 'sales', 'central']);
});

test('department-scoped creators retain their inherited branch without broadening branch choices', () => {
  const grants = [{ permission: 'employee.create', scope_type: 'department', scope_id: 'sales' }];
  const scopedOrg = visibleOrg(org, grants);
  assert.deepEqual(scopedOrg.branches, []);
  const form = mount(scopedOrg); form.change('department', 'sales');
  assert.deepEqual(form.options('branch'), ['', 'main']);
  assert.equal(form.field('branch').props.value, 'main');
  assert.equal(hasPerm(grants, 'employee.create', { entityId: form.value.entity_id, branchId: form.value.branch_id, deptId: form.value.department_id }), true);
  assert.deepEqual(form.options('department'), ['', 'sales']);
  form.change('branch', '');
  assert.equal(form.value.department_id, '');
  assert.deepEqual(form.options('branch'), [''], 'inherited option is not an independent branch grant');
});

test('company-wide departments preserve an explicit branch and remain usable without one', () => {
  const withoutBranch = mount(); withoutBranch.change('department', 'central');
  assert.equal(withoutBranch.value.branch_id, '');
  const withBranch = mount(org, { branch_id: 'main' }); withBranch.change('department', 'central');
  assert.equal(withBranch.value.branch_id, 'main');
  withBranch.change('department', ''); assert.equal(withBranch.value.branch_id, 'main');
});

test('designation choices match company and selected department while preserving shared titles', () => {
  const form = mount();
  assert.deepEqual(form.options('designation'), ['', 'shared', 'company-title']);
  form.change('department', 'sales');
  assert.deepEqual(form.options('designation'), ['', 'shared', 'company-title', 'sales-title']);
  form.change('designation', 'sales-title');
  assert.equal(form.value.designation_id, 'sales-title');
  form.change('branch', 'north');
  assert.equal(form.value.department_id, ''); assert.equal(form.value.designation_id, '');
  assert.deepEqual(form.options('designation'), ['', 'shared', 'company-title']);
  form.change('department', 'production');
  assert.deepEqual(form.options('designation'), ['', 'shared', 'company-title', 'production-title']);
});

test('company changes clear all descendants and do not offer foreign or inactive hierarchy rows', () => {
  const form = mount(org, { branch_id: 'main', department_id: 'sales', designation_id: 'sales-title' });
  form.change('entity', 'other');
  assert.deepEqual(form.value, { entity_id: 'other', branch_id: '', department_id: '', designation_id: '' });
  assert.deepEqual(form.options('branch'), ['', 'foreign']);
  assert.deepEqual(form.options('department'), ['', 'foreign-dept']);
  assert.deepEqual(form.options('designation'), ['', 'shared', 'foreign-title']);
});
