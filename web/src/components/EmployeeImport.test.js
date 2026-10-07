import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import React from 'react';
import { createServer, transformWithOxc } from 'vite';

const target = new URL('./EmployeeImport.jsx', import.meta.url);
const { code } = await transformWithOxc(await readFile(target, 'utf8'), target.pathname, { jsx: { runtime: 'automatic' } });
const stubs = {
  react: `import React from ${JSON.stringify(import.meta.resolve('react'))}; export default React;
    export const useState = initial => globalThis.importUI.state(initial); export const useMemo = calculate => calculate(); export const useCallback = callback => callback;`,
  '../data/org': 'export const useVisibleOrg = () => ({ data: globalThis.importUI.org });',
  '../data/employees': 'export const useEmployees = () => ({ data: globalThis.importUI.employees });',
  '../data/shifts': 'export const useShifts = () => globalThis.importUI.shifts;',
  '../auth/usePermissions': 'export const usePermissions = () => ({ isSuperAdmin: true, canAny: () => true });',
  '@tanstack/react-query': 'export const useQueryClient = () => ({ invalidateQueries: options => globalThis.importUI.invalidations.push(options) });',
  '../data/employeeImport': `export const detectLayout = (...args) => globalThis.importUI.logic.detectLayout(...args);
    export const extractPeople = (...args) => globalThis.importUI.logic.extractPeople(...args);
    export const planImport = (...args) => globalThis.importUI.logic.planImport(...args);
    export const runImport = async payload => { globalThis.importUI.submitted.push(payload); return { created: payload.rows.filter(row => row.status === 'new').length, updated: 0, branches: 0, designations: 0 }; };`,
  '../lib/employeeSpreadsheet': 'export const readEmployeeSheet = () => globalThis.importUI.sheet;',
  './ui/PageHeader': 'export default "page-header";',
  './ui/PagedCollection': 'export default "paged-collection";',
};
const loader = registerHooks({
  resolve(specifier, context, next) { return context.parentURL === target.href && stubs[specifier]
    ? { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true } : next(specifier, context); },
  load(url, context, next) { return url === target.href ? { format: 'module', source: code, shortCircuit: true } : next(url, context); },
});
const { default: EmployeeImport, ImportPreview } = await import(target.href);
let server, logic;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  logic = await server.ssrLoadModule('/src/data/employeeImport.js');
});
after(async () => { await server?.close(); loader.deregister(); delete globalThis.importUI; });
const nodes = (node, predicate) => !React.isValidElement(node) ? []
  : [...(predicate(node) ? [node] : []), ...React.Children.toArray(node.props.children).flatMap(child => nodes(child, predicate))];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : React.isValidElement(node) ? React.Children.toArray(node.props.children).map(text).join('') : '';
function mount(sheet = [['Employee Name'], ['Synthetic employee']]) {
  const slots = []; let cursor = 0;
  const ui = { sheet, logic, employees: [], submitted: [], invalidations: [],
    org: { entities: [{ id: 'company', code: 'CO', name: 'Synthetic company' }, { id: 'other', code: 'OTHER', name: 'Other company' }], branches: [], designations: [] },
    shifts: { data: [
      { id: 'day', entity_id: 'company', is_active: true, code: 'DAY', name: 'Day duty', start_time: '09:00', end_time: '17:30', full_day_minutes: 510 },
      { id: 'night', entity_id: null, is_active: true, code: 'NIGHT', name: 'Night duty', start_time: '22:00', end_time: '06:00', full_day_minutes: 480, crosses_midnight: true },
    ], isLoading: false, error: null },
    state(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
    render() { cursor = 0; globalThis.importUI = ui; this.tree = EmployeeImport({}); return this.tree; },
    byId(id) { const found = nodes(this.tree, node => node.props.id === id)[0]; assert.ok(found, `${id} exists`); return found; },
    change(id, value) { this.byId(id).props.onChange({ target: { value } }); this.render(); },
    button() { return nodes(this.tree, node => node.type === 'button' && /Import \d+ people|Update \d+ people|Add \d+/.test(text(node)))[0]; },
    async upload() { await nodes(this.tree, node => node.type === 'input' && node.props.type === 'file')[0].props.onChange({ target: { files: [{ name: 'synthetic.csv', arrayBuffer: async () => new ArrayBuffer(0) }] } }); this.render(); },
  };
  ui.render(); return ui;
}

test('new employee import stays blocked until an explicit shift and join date are reviewed', async () => {
  const ui = mount(); await ui.upload(); ui.change('imp-entity', 'company');
  assert.equal(ui.button().props.disabled, true);
  ui.change('imp-shift', 'day');
  assert.equal(ui.button().props.disabled, true);
  ui.change('imp-join-date', '2026-10-07');
  assert.equal(ui.button().props.disabled, false);
  const preview = nodes(ui.tree, node => node.type === ImportPreview)[0].props.rows[0];
  assert.equal(preview.initialShiftLabel, 'DAY — Day duty');
  assert.equal(preview.resolvedJoinDate, '2026-10-07');
  await ui.button().props.onClick(); ui.render();
  assert.equal(ui.submitted.length, 1);
  assert.equal(ui.submitted[0].rows[0].initialShiftId, 'day');
  assert.ok(ui.invalidations.some(value => value.queryKey[0] === 'shift-assignments'));
});

test('complete per-row CSV setup can import without batch defaults', async () => {
  const ui = mount([['Employee Name', 'Join Date', 'Shift'], ['Synthetic night employee', '01/09/2026', 'NIGHT']]);
  await ui.upload(); ui.change('imp-entity', 'company');
  assert.equal(ui.button().props.disabled, false);
  assert.equal(nodes(ui.tree, node => node.type === ImportPreview)[0].props.rows[0].initialShiftId, 'night');
});

test('changing company clears a previously selected company shift', async () => {
  const ui = mount(); await ui.upload(); ui.change('imp-entity', 'company');
  ui.change('imp-shift', 'day'); ui.change('imp-join-date', '2026-10-07');
  ui.change('imp-entity', 'other');
  assert.equal(ui.byId('imp-shift').props.value, '');
  assert.equal(ui.button().props.disabled, true);
  assert.equal(nodes(ui.byId('imp-shift'), node => node.type === 'option' && node.props.value === 'day').length, 0);
});

test('a failed shift lookup blocks creation and gives a visible error', async () => {
  const ui = mount([['Employee Name', 'Join Date', 'Shift'], ['Synthetic employee', '2026-10-07', 'DAY']]);
  await ui.upload(); ui.change('imp-entity', 'company');
  ui.shifts.error = new Error('Shift access could not be loaded'); ui.render();
  assert.equal(ui.button().props.disabled, true);
  assert.match(text(ui.tree), /Shift access could not be loaded/);
});
