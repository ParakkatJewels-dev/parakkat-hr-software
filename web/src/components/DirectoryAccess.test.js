import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { setImmediate } from 'node:timers';
import React from 'react';
import { transformWithOxc } from 'vite';
import { hasPerm } from '../lib/permissionMatch.js';

// Exercise the real form and save handlers; only hooks and external I/O are substituted.
const target = new URL('./Directory.jsx', import.meta.url);
const code = (await transformWithOxc(await readFile(target, 'utf8'), target.pathname,
  { jsx: { runtime: 'automatic' } })).code;
const stubs = {
  react: `import React from ${JSON.stringify(import.meta.resolve('react'))};
    export const useState = value => globalThis.directoryAccessTest.state(value);
    export const useMemo = fn => fn(), useCallback = fn => fn, useDeferredValue = value => value, useEffect = () => {};
    export default { ...React, useEffect };`,
  'react-router-dom': 'export const useLocation = () => ({pathname:"/directory"}), useNavigate = () => () => {};',
  '../auth/AuthContext': 'export const useAuth = () => globalThis.directoryAccessTest.auth;',
  '../auth/usePermissions': 'export const usePermissions = () => globalThis.directoryAccessTest.permissions;',
  '../data/employees': `export const useEmployees = () => ({data:[]}), useEmployee = () => ({});
    export const useCreateEmployee = () => globalThis.directoryAccessTest.create;
    export const useUpdateEmployee = () => globalThis.directoryAccessTest.other;`,
  '../data/payroll': 'export const useSalaryStructures = () => ({data:[]}), useSaveSalaryStructure = () => globalThis.directoryAccessTest.other;',
  '../data/documents': `export const useAddDocument = () => globalThis.directoryAccessTest.other;
    export const useEmployeeDocuments = () => ({data:[]}), useDocumentLink = () => ({}), useEmployeeAvatars = () => ({data:{}});
    export const ACCEPTED_FILES = "", MAX_FILE_BYTES = 1000000, PHOTO_CATEGORY = "Photo", fileSize = value => String(value);`,
  '../data/org': 'export const useVisibleOrg = () => ({data:globalThis.directoryAccessTest.org});',
  '../data/admin': 'export const useGrantAppAccess = () => globalThis.directoryAccessTest.grant;',
  './GrantAccessPanel': `export { grantableRoles } from ${JSON.stringify(new URL('../lib/roleGrants.js', import.meta.url).href)};
    export const randomPassword = () => "Temporary123"; export default "grant-access";`,
  './EmployeeOrgFields': 'export const EmployeeOrgFields = "employee-org-fields";',
  './EmployeeProfile': 'export default "employee-profile";',
  './ui/Skeleton': 'export const SkeletonForm = "skeleton-form", SkeletonRows = "skeleton-rows";',
  './ui/FilterSelect': 'export default "filter-select";',
  './ui/Btn': 'export const btnClass = () => "button";',
  './ui/Pagination': 'export default "pagination";',
  './ui/PagedCollection': 'export default "paged-collection";',
  './ui/IconInput': 'export default "icon-input";',
  './directoryExport': 'export const exportEmployeeDirectory = () => {};',
  '../lib/useMediaQuery': 'export const useMediaQuery = () => false;',
};
const loader = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === target.href) {
      if (stubs[specifier]) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
      if (specifier.startsWith('../lib/')) return next(new URL(`${specifier}.js`, target).href, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) { return url === target.href ? { source: code, format: 'module', shortCircuit: true } : next(url, context); },
});
const { default: Directory } = await import(target.href);
after(() => { loader.deregister(); delete globalThis.directoryAccessTest; });

function find(element, predicate) {
  if (!React.isValidElement(element)) return null;
  if (predicate(element)) return element;
  for (const child of React.Children.toArray(element.props.children)) {
    const match = find(child, predicate);
    if (match) return match;
  }
  return null;
}
const placement = { entity_id: 'company', branch_id: 'branch', department_id: 'department' };
const grant = (permission, scope_type = 'entity', scope_id = 'company') => ({ permission, scope_type, scope_id });
function mount(role, rank, grants, isSuperAdmin = false) {
  const slots = { directory: [], form: [] };
  let component = 'directory', cursor = 0;
  const writes = [], accessWrites = [];
  const harness = {
    auth: { rank, assignments: [{ role, scope_type: 'entity', scope_id: 'company' }], permissions: grants },
    org: { entities: [{ id: 'company', name: 'Company' }], branches: [{ id: 'branch', entity_id: 'company', zone_id: 'zone' }], departments: [], designations: [] },
    state(initial) {
      const index = cursor++;
      const state = slots[component];
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
      return [state[index], next => { state[index] = typeof next === 'function' ? next(state[index]) : next; }];
    },
    create: { reset() {}, async mutateAsync(payload) { writes.push(payload); return { id: 'new-person', full_name: payload.full_name }; } },
    grant: { reset() {}, async mutateAsync(payload) { accessWrites.push(payload); } },
    other: { reset() {}, async mutateAsync() {} },
  };
  harness.permissions = {
    isSuperAdmin,
    canAny: permission => isSuperAdmin || grants.some(row => row.permission === permission),
    canAcrossBranches: () => false,
    can: (permission, scope) => hasPerm(grants, permission, scope, { isSuperAdmin }),
  };
  globalThis.directoryAccessTest = harness;
  const renderDirectory = () => { component = 'directory'; cursor = 0; return Directory(); };
  const add = find(renderDirectory(), node => node.type === 'button' && find(node, child => child.type === 'span' && child.props.children === 'Add person'));
  assert.ok(add, 'Employee create remains available');
  add.props.onClick();
  const formElement = () => find(renderDirectory(), node => node.type?.name === 'EmployeeFormModal');
  const render = () => { const form = formElement(); component = 'form'; cursor = 0; return form.type(form.props); };
  const input = id => find(render(), node => node.props.id === id);
  input('emp-full-name').props.onChange({ target: { value: 'New Staff Member' } });
  find(render(), node => node.type === 'employee-org-fields').props.onChange(placement);
  return { writes, accessWrites, render, input, formElement,
    async submit() {
      find(render(), node => node.type === 'form').props.onSubmit({ preventDefault() {} });
      // The React handler calls an async save callback without returning it.
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

for (const [role, rank, scope, scopeId] of [['zonal_manager', 50, 'zone', 'zone'], ['branch_manager', 40, 'branch', 'branch'], ['dept_head', 30, 'department', 'department']]) {
  test(`${role} saves staff without login controls, credentials, or a provisioning attempt`, async () => {
    const form = mount(role, rank, [grant('employee.create', scope, scopeId)]);
    assert.equal(form.input('emp-login-email'), null);
    assert.equal(form.input('emp-temp-password'), null);
    await form.submit();
    assert.equal(form.writes.length, 1);
    assert.equal(form.writes[0].provisionLogin, false);
    assert.deepEqual(form.accessWrites, []);
    assert.equal(form.formElement(), null, 'Successful save closes the form');
  });
}

for (const [role, rank, superAdmin] of [['hr_manager', 60, false], ['entity_admin', 80, false], ['super_admin', 1000, true]]) {
  test(`${role} retains explicit login provisioning for staff in scope`, async () => {
    const form = mount(role, rank, [grant('employee.create'), grant('rbac.manage')], superAdmin);
    assert.ok(form.input('emp-login-email'));
    form.input('emp-email').props.onChange({ target: { value: 'new.staff@example.test' } });
    await form.submit();
    assert.equal(form.writes.length, 1);
    assert.equal(form.writes[0].provisionLogin, false, 'Explicit credentials suppress automatic provisioning');
    assert.equal(form.accessWrites.length, 1);
    assert.equal(form.accessWrites[0].email, 'new.staff@example.test');
    assert.equal(form.accessWrites[0].role_key, 'employee');
  });
}

test('an administrator can create staff outside their separate login-management scope without provisioning access', async () => {
  const form = mount('hr_manager', 60, [grant('employee.create'), grant('rbac.manage', 'entity', 'other-company')]);
  assert.equal(form.input('emp-login-email'), null);
  await form.submit();
  assert.equal(form.writes.length, 1);
  assert.equal(form.writes[0].provisionLogin, false);
  assert.deepEqual(form.accessWrites, []);
});

test('automatic provisioning checks the selected branch ancestry for a zone-scoped administrator', async () => {
  const form = mount('hr_manager', 60, [grant('employee.create'), grant('rbac.manage', 'zone', 'zone')]);
  assert.ok(form.input('emp-login-email'));
  await form.formElement().props.onSubmit({ ...placement, full_name: 'Default Login' }, null, [], null);
  assert.equal(form.writes[0].provisionLogin, true);
});
