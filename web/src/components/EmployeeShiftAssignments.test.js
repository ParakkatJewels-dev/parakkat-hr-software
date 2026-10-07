import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer, transformWithOxc } from 'vite';

const employee = (id, company = 'company-a', status = 'Active') => ({ id, full_name: `Person ${id}`, employee_code: `EMP-${id}`,
  status, entity_id: company, branch_id: `${company}-branch`, entity: { name: company }, branch: { name: `${company} branch` } });
const shifts = [
  { id: 'day-a', entity_id: 'company-a', name: 'Early day', code: 'DAY-A', start_time: '09:00', end_time: '17:30', full_day_minutes: 510, is_active: true, is_default: true },
  { id: 'day-b', entity_id: 'company-b', name: 'Later day', code: 'DAY-B', start_time: '09:30', end_time: '18:00', full_day_minutes: 510, is_active: true, is_default: true },
  { id: 'night', entity_id: null, name: 'Night duty', code: 'NIGHT', start_time: '22:00', end_time: '06:30', crosses_midnight: true, full_day_minutes: 480, is_active: true },
  { id: 'old', entity_id: null, name: 'Retired shift', code: 'OLD', full_day_minutes: 480, is_active: false },
];
function clientFor(employees = [employee('1'), employee('2'), employee('3', 'company-b')], assignments = []) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, retryOnMount: false, staleTime: Infinity } } });
  for (const [queryKey, data] of [[['employees'], employees], [['shifts'], shifts], [['shift-assignments', 'all'], assignments]]) client.setQueryData(queryKey, data);
  return client;
}
function queryError(client, key, message) {
  client.getQueryCache().find({ queryKey: key, exact: true }).setState({ status: 'error', fetchStatus: 'idle', error: new Error(message) });
}
let server, Component, AuthContext;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ default: Component } = await server.ssrLoadModule('/src/components/EmployeeShiftAssignments.jsx'));
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
});
after(async () => { await server?.close(); loader.deregister(); delete globalThis.shiftAssignmentUI; });
function render(client, auth = {}) {
  return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
    React.createElement(AuthContext.Provider, { value: { isSuperAdmin: true, permissions: [], assignments: [], employee: null, ...auth } }, React.createElement(Component))));
}

// Real handlers with isolated hook scheduling and I/O; synthetic cached queries never write company data.
const sourceUrl = new URL('./EmployeeShiftAssignments.jsx', import.meta.url);
const { code } = await transformWithOxc(await readFile(sourceUrl, 'utf8'), sourceUrl.pathname, { jsx: { runtime: 'automatic' } });
const stubs = {
  react: 'export const useState = initial => globalThis.shiftAssignmentUI.state(initial); export const useMemo = calculate => calculate();',
  '../data/employees': 'export const useEmployees = () => globalThis.shiftAssignmentUI.query(["employees"]);',
  '../data/shifts': `export const useShiftAssignments = () => globalThis.shiftAssignmentUI.query(['shift-assignments','all']);
    export const useShifts = () => globalThis.shiftAssignmentUI.query(['shifts']);
    export const useAssignEmployeeShifts = () => globalThis.shiftAssignmentUI.mutation;`,
  '../data/attendance': 'export const todayIso = () => "2026-10-07";',
  '../auth/usePermissions': 'export const usePermissions = () => ({ can: (_permission, scope) => globalThis.shiftAssignmentUI.can(scope) });',
  './ui/Pagination': 'export default "shift-pagination"; export const usePagination = (rows, size) => globalThis.shiftAssignmentUI.paginate(rows,size);',
  './ui/Btn': 'export const btnClass = () => "button";',
};
const loader = registerHooks({
  resolve(specifier, context, next) {
    return context.parentURL === sourceUrl.href && stubs[specifier]
      ? { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) { return url === sourceUrl.href ? { format: 'module', source: code, shortCircuit: true } : next(url, context); },
});
const { default: Handlers } = await import(sourceUrl.href);
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : React.isValidElement(node) ? React.Children.toArray(node.props.children).map(text).join('') : '';
const nodes = (node, predicate) => !React.isValidElement(node) ? []
  : [...(predicate(node) ? [node] : []), ...React.Children.toArray(node.props.children).flatMap(child => nodes(child, predicate))];
function mount(client = clientFor()) {
  const slots = []; let cursor = 0;
  const ui = { client, page: 1, can: () => true,
    state(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
    query(key) { const state = client.getQueryState(key); return { data: state?.data, error: state?.error, isLoading: state?.status === 'pending' }; },
    paginate(rows, size) { return { slice: rows.slice((this.page - 1) * size, this.page * size), page: this.page, pageSize: size, count: rows.length }; },
    mutation: { calls: [], isPending: false, error: null,
      mutate(payload, callbacks) { this.calls.push(structuredClone(payload)); this.callbacks = callbacks; this.isPending = true; },
      success() { this.isPending = false; this.error = null; this.callbacks.onSuccess({ employee_count: this.calls.at(-1).employeeIds.length }); },
      fail(message) { this.isPending = false; this.error = new Error(message); },
    },
    render() { cursor = 0; globalThis.shiftAssignmentUI = ui; this.tree = Handlers(); return this.tree; },
    byLabel(label) { const direct = nodes(this.tree, node => node.props['aria-label'] === label)[0];
      if (direct) return direct;
      const wrapper = nodes(this.tree, node => node.type === 'label' && text(node).startsWith(label))[0];
      const control = wrapper && nodes(wrapper, node => ['input', 'select'].includes(node.type))[0];
      assert.ok(control, `Control ${label} exists`); return control; },
    change(label, value) { this.byLabel(label).props.onChange({ target: { value } }); this.render(); },
    select(id) { this.byLabel(`Select Person ${id}`).props.onChange(); this.render(); },
    submit() { nodes(this.tree, node => node.type === 'form')[0].props.onSubmit({ preventDefault() {} }); this.render(); },
  };
  ui.render(); return ui;
}

test('assignment table pages 675 employees and shows effective/default salary hours with history', () => {
  const client = clientFor(Array.from({ length: 675 }, (_, index) => employee(String(index + 1))),
    [{ id: 'assignment', employee_id: '1', shift_id: 'night', effective_from: '2000-01-01', effective_to: null, note: 'Night roster' }]);
  try {
    const html = render(client);
    assert.equal((html.match(/aria-label="Select Person /g) ?? []).length, 25);
    for (const value of ['of 675 employees', 'Page 1 of 27', 'Night duty', '(+1 day)', '8h 0m', '8h 30m', 'Default shift', 'Assignment history', 'Night roster']) assert.ok(html.includes(value), value);
    assert.doesNotMatch(html, /aria-label="Select Person 675"/);
    assert.doesNotMatch(html, /<option[^>]*value="old"/);
  } finally { client.clear(); }
});

test('active is the initial filter and out-of-scope employees cannot be offered for assignment', () => {
  const client = clientFor([employee('1'), employee('2', 'company-b'), employee('inactive', 'company-a', 'Inactive')]);
  try {
    const html = render(client, { isSuperAdmin: false, permissions: [{ permission: 'shift.manage', scope_type: 'entity', scope_id: 'company-a' }] });
    assert.match(html, /aria-label="Select Person 1"/);
    assert.match(html, /<option value="active" selected="">Active<\/option>/);
    assert.match(html, /<option value="all">All employees<\/option>/);
    assert.doesNotMatch(html, /aria-label="Select Person (2|inactive)"/);
  } finally { client.clear(); }
});

test('all employees includes scoped leavers for historical assignments and changing status clears selection', () => {
  const client = clientFor([employee('1'), employee('leaver', 'company-a', 'Inactive'), employee('outside', 'company-b', 'Inactive')]);
  const ui = mount(client); ui.can = scope => scope.entityId === 'company-a'; ui.render();
  try {
    assert.equal(nodes(ui.tree, node => node.props['aria-label'] === 'Select Person leaver').length, 0);
    ui.select('1'); ui.change('Assignment employee status', 'all');
    assert.match(text(ui.tree), /0 selected/);
    assert.equal(nodes(ui.tree, node => node.props['aria-label'] === 'Select Person outside').length, 0);
    ui.select('leaver'); ui.change('Assign shift', 'day-a');
    ui.change('Effective from', '2026-09-01'); ui.change('End date (optional)', '2026-09-18'); ui.submit();
    assert.deepEqual(ui.mutation.calls[0], { employeeIds: ['leaver'], shiftId: 'day-a', effectiveFrom: '2026-09-01', effectiveTo: '2026-09-18', note: null });
    ui.mutation.fail('Review this historical assignment'); ui.render();
    ui.change('Assignment employee status', 'active');
    assert.match(text(ui.tree), /0 selected/);
    assert.equal(nodes(ui.tree, node => node.props['aria-label'] === 'Select Person leaver').length, 0);
    ui.submit(); assert.equal(ui.mutation.calls.length, 1, 'hidden former selection is not reassigned');
  } finally { client.clear(); }
});

test('query errors block assignment without claiming an empty search result', () => {
  const client = clientFor([]); queryError(client, ['employees'], 'Employee directory unavailable');
  try { const html = render(client); assert.match(html, /role="alert"/); assert.match(html, /Employee directory unavailable/);
    assert.doesNotMatch(html, /No employees match/); assert.match(html, /type="submit"[^>]*disabled/); }
  finally { client.clear(); }
});

test('page selection survives search and submits one reviewed atomic employee batch', () => {
  const client = clientFor(Array.from({ length: 30 }, (_, index) => employee(String(index + 1)))); const ui = mount(client);
  try {
    ui.byLabel('Select this page of employees').props.onChange(); ui.render();
    ui.change('Search employees', 'Person 30'); ui.select('30');
    ui.change('Assign shift', 'night'); ui.change('Effective from', '2026-10-10'); ui.change('End date (optional)', '2026-10-20');
    ui.change('Note (optional)', '  Approved October night roster  ');
    assert.match(text(ui.tree), /26 selected \(including employees outside this search\)/);
    ui.submit();
    assert.deepEqual(ui.mutation.calls, [{ employeeIds: [...Array.from({ length: 25 }, (_, i) => String(i + 1)), '30'], shiftId: 'night', effectiveFrom: '2026-10-10', effectiveTo: '2026-10-20', note: 'Approved October night roster' }]);
    assert.equal(nodes(ui.tree, node => node.type === 'fieldset')[0].props.disabled, true);
    ui.submit(); assert.equal(ui.mutation.calls.length, 1);
    ui.mutation.success(); ui.render();
    assert.match(text(ui.tree), /26 employees assigned to Night duty from 2026-10-10/); assert.match(text(ui.tree), /0 selected/);
  } finally { client.clear(); }
});

test('cross-company selection only offers shared shifts and company filter clears old selection', () => {
  const client = clientFor(); const ui = mount(client);
  try {
    ui.select('1'); ui.change('Assign shift', 'day-a'); ui.select('3');
    assert.equal(ui.byLabel('Assign shift').props.value, '');
    assert.deepEqual(nodes(ui.byLabel('Assign shift'), node => node.type === 'option').map(node => node.props.value), ['', 'night']);
    ui.submit(); assert.equal(ui.mutation.calls.length, 0);
    ui.change('Assignment company', 'company-b');
    assert.match(text(ui.tree), /0 selected/); assert.equal(ui.byLabel('Assign shift').props.value, '');
    assert.equal(nodes(ui.tree, node => node.props['aria-label'] === 'Select Person 1').length, 0);
  } finally { client.clear(); }
});

test('failed mutation keeps selection but concurrent query failure blocks retry', () => {
  const client = clientFor(); const ui = mount(client);
  try {
    ui.select('1'); ui.change('Assign shift', 'night'); ui.submit(); ui.mutation.fail('Published payroll dates cannot change.'); ui.render();
    assert.match(text(ui.tree), /Published payroll dates cannot change/); assert.match(text(ui.tree), /1 selected/);
    queryError(client, ['shift-assignments', 'all'], 'Refresh the assignment history'); ui.render(); ui.submit();
    assert.equal(ui.mutation.calls.length, 1);
    client.setQueryData(['shift-assignments', 'all'], []); ui.render(); ui.submit(); assert.equal(ui.mutation.calls.length, 2);
  } finally { client.clear(); }
});

test('invalid date ranges block submit and finite assignment explains default fallback', () => {
  const client = clientFor(); const ui = mount(client);
  try {
    ui.select('1'); ui.change('Assign shift', 'night'); ui.change('End date (optional)', '2026-10-01');
    assert.match(text(ui.tree), /previous shift does not resume automatically/); ui.submit(); assert.equal(ui.mutation.calls.length, 0);
    ui.change('End date (optional)', ''); ui.change('Effective from', ''); ui.submit(); assert.equal(ui.mutation.calls.length, 0);
  } finally { client.clear(); }
});
