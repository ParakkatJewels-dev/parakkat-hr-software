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
  '../data/shifts': 'export const useShifts = () => globalThis.directoryAccessTest.shifts;',
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
  './LoginHandoverNotice': 'export default "login-handover";',
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
const shiftRows = [
  { id: 'day', entity_id: 'company', name: 'Day shift', start_time: '09:00:00', end_time: '17:30:00', full_day_minutes: 510, is_active: true, is_default: true },
  { id: 'night', entity_id: null, name: 'Night shift', start_time: '22:00:00', end_time: '06:30:00', full_day_minutes: 480, crosses_midnight: true, is_active: true },
  { id: 'other', entity_id: 'other-company', name: 'Other company shift', start_time: '09:30:00', end_time: '18:00:00', full_day_minutes: 510, is_active: true, is_default: true },
  { id: 'old', entity_id: 'company', name: 'Inactive shift', is_active: false },
];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : React.isValidElement(node) ? React.Children.toArray(node.props.children).map(text).join('') : '';
function mount(role, rank, grants, isSuperAdmin = false, { loginResult, grantResult, shiftQuery, joinDate = '2026-10-01', editEmployee } = {}) {
  const slots = { directory: [], form: [] };
  let component = 'directory', cursor = 0;
  const writes = [], accessWrites = [];
  const harness = {
    auth: { rank, assignments: [{ role, scope_type: 'entity', scope_id: 'company' }], permissions: grants },
    org: { entities: [{ id: 'company', name: 'Company' }], branches: [{ id: 'branch', entity_id: 'company', zone_id: 'zone' }], departments: [], designations: [] },
    shifts: { data: shiftRows, isPending: false, isLoading: false, error: null, refetch() {}, ...shiftQuery },
    state(initial) {
      const index = cursor++;
      const state = slots[component];
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
      return [state[index], next => { state[index] = typeof next === 'function' ? next(state[index]) : next; }];
    },
    create: { reset() {}, async mutateAsync(payload) { writes.push(payload); return { id: 'new-person', full_name: payload.full_name, login: loginResult }; } },
    grant: { reset() {}, async mutateAsync(payload) { accessWrites.push(payload); return grantResult ?? { created: true, email: payload.email }; } },
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
  const render = () => { const form = formElement(); component = 'form'; cursor = 0;
    return form.type({ ...form.props, ...(editEmployee ? { employee: editEmployee, onSubmit: payload => writes.push(payload) } : {}) }); };
  const input = id => find(render(), node => node.props.id === id);
  input('emp-full-name').props.onChange({ target: { value: 'New Staff Member' } });
  find(render(), node => node.type === 'employee-org-fields').props.onChange(placement);
  if (joinDate !== null) input('emp-join-date').props.onChange({ target: { value: joinDate } });
  return { writes, accessWrites, render, input, formElement, harness,
    changePlacement(value) { find(render(), node => node.type === 'employee-org-fields').props.onChange(value); },
    handover: () => find(renderDirectory(), node => node.type === 'login-handover')?.props.login,
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

test('creation visibly selects the company default and saves its initial shift from the required join date', async () => {
  const form = mount('branch_manager', 40, [grant('employee.create', 'branch', 'branch')]);
  assert.equal(form.input('emp-join-date').props.required, true);
  assert.equal(form.input('emp-shift').props.value, 'day');
  assert.match(text(form.input('emp-shift')), /Day shift · 09:00–17:30 · 8h 30m paid · default/);
  assert.doesNotMatch(text(form.input('emp-shift')), /Inactive shift|Other company shift/);
  assert.match(text(form.render()), /Daily salary basis: 8h 30m. Assigned from 2026-10-01/);
  await form.submit();
  assert.equal(form.writes.length, 1);
  assert.equal(form.writes[0].shift_id, 'day');
  assert.equal(form.writes[0].join_date, '2026-10-01');
  assert.equal(form.writes[0].provisionLogin, false, 'employee.create does not require shift.manage or login rights');
});

test('a shared night shift can replace the visible default and company changes clear incompatible choices', async () => {
  const form = mount('super_admin', 1000, [], true);
  form.input('emp-email').props.onChange({ target: { value: 'night@example.test' } });
  form.input('emp-shift').props.onChange({ target: { value: 'night' } });
  assert.match(text(form.render()), /22:00–06:30 · ends next day IST · Daily salary basis: 8h 0m/);
  form.input('emp-shift').props.onChange({ target: { value: 'day' } });
  form.changePlacement({ entity_id: 'other-company', branch_id: '', department_id: '' });
  assert.equal(form.input('emp-shift').props.value, 'other');
  assert.doesNotMatch(text(form.input('emp-shift')), /Day shift/);
  form.input('emp-shift').props.onChange({ target: { value: 'night' } });
  await form.submit();
  assert.equal(form.writes[0].shift_id, 'night');
  assert.equal(form.writes[0].entity_id, 'other-company');
});

test('blank, missing and impossible create dates or unselected shifts cannot start employee creation', async () => {
  const form = mount('branch_manager', 40, [grant('employee.create', 'branch', 'branch')], false, { joinDate: null });
  await form.submit(); assert.equal(form.writes.length, 0);
  form.input('emp-join-date').props.onChange({ target: { value: '2026-02-30' } });
  await form.submit(); assert.equal(form.writes.length, 0);
  form.input('emp-join-date').props.onChange({ target: { value: '2026-09-01' } });
  form.input('emp-shift').props.onChange({ target: { value: '' } });
  assert.equal(form.input('emp-shift').props.value, '', 'explicitly clearing the picker must not silently restore the default');
  await form.submit(); assert.equal(form.writes.length, 0);
  form.input('emp-shift').props.onChange({ target: { value: 'other' } });
  await form.submit(); assert.equal(form.writes.length, 0);
});

test('loading, failed and empty shift lists block create; refetch failure cannot reuse a stale default', async () => {
  for (const shiftQuery of [{ data: undefined, isPending: true }, { error: new Error('Shift connection unavailable') }, { data: [] }]) {
    const form = mount('branch_manager', 40, [grant('employee.create', 'branch', 'branch')], false, { shiftQuery });
    await form.submit(); assert.equal(form.writes.length, 0);
    assert.match(text(form.render()), /Loading available shifts|Could not load shifts|No active shift/);
  }
});

test('employee edits preserve dated assignments and save without shift data or a new join date', async () => {
  const form = mount('branch_manager', 40, [grant('employee.create', 'branch', 'branch'), grant('employee.update', 'branch', 'branch')], false,
    { editEmployee: { id: 'existing', full_name: 'Existing person', ...placement }, joinDate: null, shiftQuery: { error: new Error('Shifts unavailable') } });
  assert.equal(form.input('emp-shift'), null);
  assert.equal(form.input('emp-join-date').props.required, false);
  assert.match(text(form.render()), /Existing shift assignments stay unchanged/);
  await form.submit();
  assert.equal(form.writes.length, 1);
  assert.equal(Object.hasOwn(form.writes[0], 'shift_id'), false);
  assert.equal(form.writes[0].join_date, null);
});

test('automatic provisioning checks the selected branch ancestry for a zone-scoped administrator', async () => {
  const form = mount('hr_manager', 60, [grant('employee.create'), grant('rbac.manage', 'zone', 'zone')]);
  assert.ok(form.input('emp-login-email'));
  await form.formElement().props.onSubmit({ ...placement, full_name: 'Default Login' }, null, [], null);
  assert.equal(form.writes[0].provisionLogin, true);
});

for (const created of [true, false]) {
  test(`manual employee save reports ${created ? 'the installed temporary password' : 'a reused login without an unsaved password'}`, async () => {
    const form = mount('super_admin', 1000, [grant('employee.create'), grant('rbac.manage')], true,
      { grantResult: { created, email: 'canonical.login@example.test' } });
    form.input('emp-email').props.onChange({ target: { value: 'proposed.login@example.test' } });
    await form.submit();
    assert.equal(form.accessWrites.length, 1);
    assert.deepEqual(form.handover(), {
      name: 'New Staff Member', email: 'canonical.login@example.test', created,
      password: created ? form.accessWrites[0].password : null,
    });
  });
}

test('automatic employee save does not hand over a password rejected by an older provisioning response', async () => {
  const form = mount('super_admin', 1000, [grant('employee.create'), grant('rbac.manage')], true,
    { loginResult: { created: true, email: 'existing@example.test', password: 'NotInstalled!42', grant: { created: false } } });
  await form.formElement().props.onSubmit({ ...placement, full_name: 'Existing Login' }, null, [], null);
  assert.equal(form.writes[0].provisionLogin, true);
  assert.deepEqual(form.handover(), { name: 'Existing Login', email: 'existing@example.test', created: false, password: null });
});
