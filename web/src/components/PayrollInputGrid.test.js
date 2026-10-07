import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import React from 'react';
import * as XLSX from 'xlsx';
import { transformWithOxc } from 'vite';
import { readPayrollInputWorkbook } from '../lib/payrollInputGrid.js';
import { normalizeMonthlyInput, PAYROLL_REGISTER_COLUMNS } from '../lib/payrollWorksheet.js';

// Run the component's handlers and state transitions, including real clipboard/import parsing.
// Only React scheduling, database hooks and child pagination/dialog rendering are isolated.
const sourceUrl = new URL('./PayrollInputGrid.jsx', import.meta.url);
const { code } = await transformWithOxc(await readFile(sourceUrl, 'utf8'), sourceUrl.pathname, { jsx: { runtime: 'automatic' } });
const helperUrl = new URL('../lib/payrollInputGrid.js', import.meta.url).href;
const stubs = {
  react: `export { default } from ${JSON.stringify(import.meta.resolve('react'))}; export const useState = value => globalThis.payrollGrid.state(value);
    export const useRef = value => globalThis.payrollGrid.state({current:value})[0];
    export const useMemo = compute => compute(); export const useEffect = () => {};`,
  'react-router-dom': 'export const Link = "a";',
  '../auth/usePermissions': 'export const usePermissions = () => ({can: () => globalThis.payrollGrid.canReadAttendance !== false});',
  'lucide-react': 'export const AlertTriangle="icon", ArrowRight="icon", Check="icon", Download="icon", FileSpreadsheet="icon", Loader2="icon", Search="icon", Upload="icon", Users="icon";',
  '@tanstack/react-query': 'export const useIsMutating = filters => { globalThis.payrollGrid.mutationFilters = filters; return globalThis.payrollGrid.activeMutations ?? 0; };',
  '../data/payrollWorksheet': `export const usePayrollMonthlyInputs = () => globalThis.payrollGrid.query;
    export const usePayrollAttendanceSummary = (_entity, _period, options) => { globalThis.payrollGrid.attendanceOptions = options; return globalThis.payrollGrid.attendance; };
    export const useSavePayrollMonthlyInputs = () => globalThis.payrollGrid.mutation;`,
  '../lib/payrollWorksheet': `export * from ${JSON.stringify(new URL('../lib/payrollWorksheet.js', import.meta.url).href)};`,
  '../lib/usePayrollSessionState': 'export const usePayrollSessionState = (key, initial) => globalThis.payrollGrid.sessionState(key, initial);',
  '../lib/payrollInputGrid': `export { applyPayrollPaste, parsePayrollPaste, parsePayrollImportRows } from ${JSON.stringify(helperUrl)};
    export const readPayrollInputWorkbook = file => globalThis.payrollGrid.readWorkbook(file);
    export const exportPayrollInputTemplate = (...args) => { globalThis.payrollGrid.downloads.push(args); };`,
  './ui/Pagination': `export default "payroll-pagination";
    export const usePagination = (rows, size, _focus, key) => globalThis.payrollGrid.paginate(rows,size,key);`,
  './ui/ConfirmDialog': 'export default "payroll-confirm";',
  './ui/Btn': 'export const btnClass = () => "button";',
  './PayrollSheetFrame': 'export default "sheet-frame";',
  './payrollInputGrid.css': 'export default {};',
};
const loader = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === sourceUrl.href && stubs[specifier]) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    return url === sourceUrl.href ? { format: 'module', source: code, shortCircuit: true } : next(url, context);
  },
});
const { default: PayrollInputGrid } = await import(sourceUrl.href);
after(() => { loader.deregister(); delete globalThis.payrollGrid; });

const text = node => ['string', 'number'].includes(typeof node) ? String(node)
  : React.isValidElement(node) ? React.Children.toArray(node.props.children).map(text).join('') : '';
function findAll(node, predicate) {
  if (!React.isValidElement(node)) return [];
  return [...(predicate(node) ? [node] : []), ...React.Children.toArray(node.props.children).flatMap(child => findAll(child, predicate))];
}
const find = (node, predicate) => findAll(node, predicate)[0] ?? null;
const matches = (actual, expected) => expected instanceof RegExp ? expected.test(actual) : expected === actual;

function mount({ count = 30, published = false, query: overrides = {}, sessionStore = new Map() } = {}) {
  const slots = []; let cursor = 0;
  const employees = Array.from({ length: count }, (_, index) => ({ id: `employee-${index + 1}`,
    full_name: `Person ${String(index + 1).padStart(2, '0')}`, employee_code: `EMP${String(index + 1).padStart(4, '0')}`,
    entity_id: 'company', branch_id: index % 2 ? 'north' : 'main',
    branch: { name: index % 2 ? 'North' : 'Main', code: index % 2 ? 'N' : 'M' }, status: 'Active' }));
  const query = { isSuccess: true, isLoading: false, isFetching: false, error: null,
    data: employees.slice(0, -1).map((person, index) => ({ employee_id: person.id,
      ...normalizeMonthlyInput({ incentive: index === 0 ? 100 : 0 }), updated_at: `revision-${person.id}` })), ...overrides };
  const mutation = { isPending: false, error: null, failure: null, deferred: null, calls: [], writes: [],
    reset() { this.error = null; },
    async mutateAsync(payload) {
      this.isPending = true; this.calls.push(structuredClone(payload));
      try {
        if (this.deferred) await this.deferred;
        if (this.failure) throw this.failure;
        const saved = payload.rows.map(row => ({ employee_id: row.employeeId, ...normalizeMonthlyInput(row.input),
          updated_at: `saved-${this.calls.length}-${row.employeeId}` }));
        const ids = new Set(saved.map(row => row.employee_id));
        query.data = [...query.data.filter(row => !ids.has(row.employee_id)), ...saved];
        this.writes.push(structuredClone(payload)); this.error = null;
        return saved;
      } catch (error) { this.error = error; throw error; }
      finally { this.isPending = false; }
    },
  };
  const attendance = { isSuccess: true, isLoading: false, isFetching: false, error: null, refetch: async () => {}, data: employees.map(person => ({ employee_id: person.id,
    recorded_worked_hours: 208, recorded_ot_hours: 4.5, recorded_late_hours: 1.5, deductible_late_hours: .5,
    effective_ot_hours: 4.5, effective_late_hours: .5, policy_deduct_late: true,
    attendance_days: 31, expected_days: 31, missing_days: 0, unresolved_days: 0, invalid_days: 0, pending_recompute_days: 0,
    last_punch_at: '2026-10-31T12:30:00Z', computed_at: '2026-10-31T12:32:00Z' })) };
  const harness = { query, attendance, mutation, page: 1, paginationKey: null, downloads: [], readWorkbook: readPayrollInputWorkbook, sessionStore,
    props: { entityId: 'company', period: '2026-10', employees, published, disabled: false },
    state(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    sessionState(key, initial) {
      const cacheKey = JSON.stringify(key);
      if (!sessionStore.has(cacheKey)) sessionStore.set(cacheKey, typeof initial === 'function' ? initial() : initial);
      return [sessionStore.get(cacheKey), next => sessionStore.set(cacheKey,
        typeof next === 'function' ? next(sessionStore.get(cacheKey)) : next)];
    },
    paginate(rows, size, key) {
      if (this.paginationKey !== key) { this.page = 1; this.paginationKey = key; }
      this.page = Math.min(this.page, Math.max(1, Math.ceil(rows.length / size)));
      return { slice: rows.slice((this.page - 1) * size, this.page * size), count: rows.length, page: this.page,
        setPage: next => { this.page = typeof next === 'function' ? next(this.page) : next; } };
    },
    render() { cursor = 0; globalThis.payrollGrid = this; return PayrollInputGrid(this.props).props.children({ control: null, expanded: false }); },
    button(label) { return find(this.render(), node => node.type === 'button' && matches(node.props['aria-label'] || text(node), label)); },
    field(label) { return find(this.render(), node => ['input', 'select', 'textarea'].includes(node.type) && node.props['aria-label'] === label); },
    click(label) {
      const button = this.button(label); assert.ok(button, `Button ${label}`); assert.ok(!button.props.disabled, `${label} is enabled`);
      return button.props.onClick();
    },
    change(label, value) {
      const field = this.field(label); assert.ok(field, `Field ${label}`); assert.ok(!field.props.disabled, `${label} is enabled`);
      return field.props.onChange({ target: { value, checked: Boolean(value) } });
    },
    cell(index, label = 'Incentive') { return this.field(`${employees[index - 1].full_name} · ${label}`); },
    edit(index, value, label = 'Incentive') { return this.change(`${employees[index - 1].full_name} · ${label}`, value); },
    nextPage(page) { find(this.render(), node => node.type === 'payroll-pagination').props.setPage(page); },
    select(index) { this.change(`Select ${employees[index - 1].full_name}`, true); },
    paste(index, value, label = 'Incentive') {
      let prevented = false;
      this.cell(index, label).props.onPaste({ clipboardData: { getData: () => value }, preventDefault() { prevented = true; } });
      return prevented;
    },
    preview() { return find(this.render(), node => node.props['aria-label'] === 'Review staged payroll changes'); },
    import(file) {
      const node = this.field('Import payroll Excel file'); assert.ok(!node.props.disabled);
      return node.props.onChange({ target: { files: [file], value: file.name } });
    },
  };
  return harness;
}

function workbookFile(rows, name = 'monthly-inputs.xlsx') {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Monthly inputs');
  const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  return { name, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

test('cell edits survive pages and filters, and one save includes all changed employees with original revisions', async () => {
  const grid = mount();
  let continued = 0;
  grid.props.onContinue = () => { continued += 1; };
  grid.edit(1, '1250.50'); grid.nextPage(2); grid.edit(26, '650'); grid.edit(30, '700');
  assert.equal(grid.button('Continue to review').props.disabled, true);
  grid.change('Search payroll employees', 'Person 01');
  assert.equal(grid.cell(1).props.value, '1250.50');
  assert.equal(grid.cell(26), null);
  assert.equal(grid.mutation.calls.length, 0);
  await grid.click('Save 3 changes');
  assert.equal(grid.mutation.writes.length, 1);
  const payload = grid.mutation.writes[0];
  assert.deepEqual([payload.entityId, payload.period], ['company', '2026-10']);
  assert.deepEqual(payload.rows.map(row => [row.employeeId, row.expectedUpdatedAt, row.input.incentive]), [
    ['employee-1', 'revision-employee-1', '1250.50'], ['employee-26', 'revision-employee-26', '650'], ['employee-30', null, '700'],
  ]);
  assert.match(text(grid.render()), /3 employee rows saved/);
  assert.equal(grid.button('Save changes').props.disabled, true);
  grid.click('Continue to review');
  assert.equal(continued, 1);
});

test('a failed atomic save preserves each draft for a successful retry', async () => {
  const grid = mount({ count: 3 });
  grid.edit(1, '250'); grid.edit(2, '450');
  grid.mutation.failure = new Error('Input conflict detected');
  await grid.click('Save 2 changes');
  assert.equal(grid.cell(1).props.value, '250');
  assert.equal(grid.cell(2).props.value, '450');
  assert.equal(grid.mutation.writes.length, 0);
  assert.match(text(grid.render()), /save could not be confirmed.*Your edits are kept/i);
  grid.mutation.failure = null;
  await grid.click('Save 2 changes');
  assert.equal(grid.mutation.writes.length, 1);
  assert.deepEqual(grid.mutation.calls[1], grid.mutation.calls[0]);
});

test('published, loading and failed reads never expose writable cells or save actions', () => {
  for (const options of [{ published: true }, { query: { isSuccess: false, isLoading: true } },
    { query: { error: new Error('Cannot read saved inputs') } }, { query: { isFetching: true } }]) {
    const grid = mount({ count: 3, ...options });
    assert.equal(grid.cell(1).props.disabled, true);
    assert.equal(grid.button('Import Excel').props.disabled, true);
    assert.equal(grid.button('Save changes').props.disabled, true);
    grid.cell(1).props.onChange({ target: { value: '900' } });
    assert.equal(grid.cell(1).props.value, '100', 'a guarded handler must not stage a write');
    assert.equal(grid.mutation.calls.length, 0);
  }
});

test('bulk fill previews selected employees across filters and does not write until Save', async () => {
  const grid = mount();
  grid.select(1); grid.nextPage(2); grid.select(26);
  grid.change('Search payroll employees', 'Person 01');
  assert.match(text(grid.render()), /2 selected \(1 outside this filter\)/);
  grid.change('Bulk fill value', '800'); grid.click('Review fill');
  assert.ok(grid.preview());
  assert.match(text(grid.preview()), /Person 01/); assert.match(text(grid.preview()), /Person 26/);
  assert.equal(grid.cell(1).props.value, '100');
  assert.equal(grid.mutation.calls.length, 0);
  grid.click('Apply 2 rows to worksheet');
  assert.equal(grid.preview(), null);
  assert.equal(grid.cell(1).props.value, '800');
  assert.equal(grid.mutation.calls.length, 0);
  await grid.click('Save 2 changes');
  assert.deepEqual(grid.mutation.writes[0].rows.map(row => row.employeeId), ['employee-1', 'employee-26']);
});

test('clipboard paste respects the current page and rejects an invalid rectangle without partial changes', () => {
  const grid = mount();
  assert.equal(grid.paste(1, '200\t300\n400\t500'), true);
  assert.equal(grid.cell(1).props.value, '200');
  assert.equal(grid.cell(1, 'Target incentive').props.value, '300');
  assert.equal(grid.cell(2).props.value, '400');
  grid.paste(1, '999\t-1\n888\t777');
  assert.equal(grid.cell(1).props.value, '200');
  assert.equal(grid.cell(2).props.value, '400');
  assert.match(text(grid.render()), /nonnegative/);
  grid.paste(25, '100\n200');
  assert.match(text(grid.render()), /exceeds/);
  assert.equal(grid.cell(25).props.value, '0');
  grid.paste(1, 'note\textra', 'Notes / deduction reason');
  assert.match(text(grid.render()), /exceeds/);
  assert.equal(grid.cell(1, 'Notes / deduction reason').props.value, '');
  assert.equal(grid.mutation.calls.length, 0);
});

test('actual Excel import creates a review, preserves blank cells and stages explicit zero overrides with notes', async () => {
  const grid = mount({ count: 3 });
  await grid.import(workbookFile([
    ['Employee Code', 'Incentive', 'PF', 'ESI', 'Notes'],
    ['EMP0001', '', 0, '', 'Approved exemption'], ['EMP0003', 525.5, '', '', 'Imported adjustment'],
  ]));
  assert.ok(grid.preview());
  assert.match(text(grid.preview()), /Import review/);
  assert.equal(grid.cell(1).props.value, '100');
  assert.equal(grid.mutation.calls.length, 0);
  grid.click('Apply 2 rows to worksheet');
  assert.equal(grid.cell(1).props.value, '100', 'blank import amounts preserve saved inputs');
  grid.click('Hours & deductions');
  assert.equal(grid.cell(1, 'PF').props.value, '0');
  assert.equal(grid.cell(1, 'ESI').props.value, '');
  assert.equal(grid.cell(1, 'Notes / deduction reason').props.value, 'Approved exemption');
  await grid.click('Save 2 changes');
  assert.equal(grid.mutation.writes[0].rows[0].input.pf, '0');
  assert.equal(grid.mutation.writes[0].rows[0].input.esi, '');
  assert.equal(grid.mutation.writes[0].rows[1].input.incentive, '525.5');
});

test('an invalid later Excel row blocks the whole preview and preserves existing drafts', async () => {
  const grid = mount({ count: 3 }); grid.edit(1, '250');
  await grid.import(workbookFile([['Employee Code', 'Incentive'], ['EMP0001', 800], ['UNKNOWN', 900]]));
  assert.ok(grid.preview());
  assert.match(text(grid.preview()), /No employee in the selected scope/);
  assert.equal(grid.button('Apply 1 rows to worksheet').props.disabled, true);
  assert.equal(grid.cell(1).props.value, '250');
  grid.click('Cancel review');
  assert.equal(grid.cell(1).props.value, '250');
  assert.equal(grid.mutation.calls.length, 0);
});

test('a background revision change preserves the typed amount and prevents saving until the row is reloaded', () => {
  const grid = mount({ count: 3 }); grid.edit(1, '400');
  grid.query.data = grid.query.data.map(row => row.employee_id === 'employee-1' ? { ...row, incentive: 800, updated_at: 'new-revision' } : row);
  assert.equal(grid.cell(1).props.value, '400');
  assert.match(text(grid.render()), /Changed elsewhere/);
  assert.match(text(grid.render()), /Saved: 800/);
  assert.equal(grid.button('Save 1 changes').props.disabled, true);
  grid.click('Reload row');
  const dialog = find(grid.render(), node => node.type === 'payroll-confirm');
  assert.ok(dialog); assert.equal(grid.cell(1).props.value, '400');
  dialog.props.onConfirm();
  assert.equal(grid.cell(1).props.value, '800');
  assert.equal(grid.mutation.calls.length, 0);
});

test('in-flight writes block a stale save handler from submitting twice or accepting another edit', async () => {
  const grid = mount({ count: 3 }); grid.edit(1, '400');
  let release;
  grid.mutation.deferred = new Promise(resolve => { release = resolve; });
  const save = grid.button('Save 1 changes').props.onClick;
  const change = grid.cell(1).props.onChange;
  const pending = save();
  await save(); change({ target: { value: '999' } });
  assert.equal(grid.mutation.calls.length, 1);
  assert.equal(grid.cell(1).props.value, '400');
  assert.equal(grid.cell(1).props.disabled, true);
  release(); await pending;
  assert.equal(grid.mutation.writes.length, 1);
});

test('a preview cannot apply against a newer saved revision or an employee removed from scope', () => {
  for (const change of ['revision', 'scope']) {
    const grid = mount({ count: 3 }); grid.select(1); grid.change('Bulk fill value', '800'); grid.click('Review fill');
    if (change === 'revision') grid.query.data = grid.query.data.map(row => row.employee_id === 'employee-1' ? { ...row, incentive: 900, updated_at: 'new-revision' } : row);
    else grid.props.employees = grid.props.employees.filter(person => person.id !== 'employee-1');
    const apply = grid.button('Apply 1 rows to worksheet');
    assert.equal(apply.props.disabled, true, change);
    assert.match(text(grid.preview()), /changed during review/);
    apply.props.onClick();
    assert.ok(grid.preview(), 'the invalid preview remains available for comparison');
    assert.equal(grid.mutation.calls.length, 0);
    assert.equal(grid.button('Save changes').props.disabled, true);
    grid.click('Cancel review');
    if (change === 'revision') assert.equal(grid.cell(1).props.value, '900');
  }
});

test('a deferred Excel read blocks editing and detects changes made while the workbook was being read', async () => {
  const grid = mount({ count: 3 });
  const busy = []; grid.props.onBusyChange = value => busy.push(value);
  let release;
  const pendingRead = new Promise(resolve => { release = resolve; });
  grid.readWorkbook = async file => { await pendingRead; return readPayrollInputWorkbook(file); };
  const importing = grid.import(workbookFile([['Employee Code', 'Incentive'], ['EMP0001', 600]]));
  assert.equal(grid.cell(1).props.disabled, true);
  assert.equal(grid.button('Import Excel').props.disabled, true);
  assert.deepEqual(busy, [true]);
  grid.query.data = grid.query.data.map(row => row.employee_id === 'employee-1' ? { ...row, incentive: 950, updated_at: 'while-reading' } : row);
  grid.render(); release(); await importing;
  assert.deepEqual(busy, [true, false]);
  assert.ok(grid.preview());
  assert.equal(grid.button('Apply 1 rows to worksheet').props.disabled, true);
  assert.match(text(grid.preview()), /changed during review/);
  assert.equal(grid.mutation.calls.length, 0);
});

test('invalid deductions block every pending row until an override reason is supplied', async () => {
  const grid = mount({ count: 3 }); grid.edit(1, '650'); grid.click('Hours & deductions'); grid.edit(2, '0', 'PF');
  assert.equal(grid.cell(2, 'PF').props['aria-invalid'], true);
  assert.equal(grid.button('Save 2 changes').props.disabled, true);
  assert.match(text(grid.render()), /Record a reason/);
  assert.equal(grid.mutation.calls.length, 0);
  grid.edit(2, 'Reviewed exemption', 'Notes / deduction reason');
  await grid.click('Save 2 changes');
  const override = grid.mutation.writes[0].rows.find(row => row.employeeId === 'employee-2');
  assert.equal(override.input.pf, '0');
  assert.equal(override.input.esi, '');
  assert.equal(override.input.notes, 'Reviewed exemption');
});

test('a remounted grid keeps its draft and blocks writes while the same company month has an active save', async () => {
  const original = mount({ count: 3 }); original.edit(1, '450');
  const remounted = mount({ count: 3, sessionStore: original.sessionStore });
  remounted.activeMutations = 1;
  assert.equal(remounted.mutation.isPending, false, 'the new hook instance does not own the earlier mutation');
  assert.equal(remounted.cell(1).props.value, '450');
  assert.equal(remounted.cell(1).props.disabled, true);
  assert.equal(remounted.button('Save 1 changes').props.disabled, true);
  assert.equal(remounted.button('Import Excel').props.disabled, true);
  assert.deepEqual(remounted.mutationFilters.mutationKey, ['save-payroll-monthly-inputs']);
  assert.equal(remounted.mutationFilters.predicate({ state: { variables: { entityId: 'company', period: '2026-10' } } }), true);
  assert.equal(remounted.mutationFilters.predicate({ state: { variables: { entityId: 'other', period: '2026-10' } } }), false);
  assert.equal(remounted.mutationFilters.predicate({ state: { variables: { entityId: 'company', period: '2026-09' } } }), false);
  await remounted.button('Save 1 changes').props.onClick();
  remounted.cell(1).props.onChange({ target: { value: '999' } });
  assert.equal(remounted.mutation.calls.length, 0);
  assert.equal(remounted.cell(1).props.value, '450');
  remounted.activeMutations = 0;
  await remounted.click('Save 1 changes');
  assert.equal(remounted.mutation.writes[0].rows[0].expectedUpdatedAt, 'revision-employee-1');
});

test('the original 33-column Excel sheet accepts one approval note only for rows missing an override reason', async () => {
  const grid = mount({ count: 3 });
  grid.query.data = grid.query.data.map(row => row.employee_id === 'employee-2'
    ? { ...row, notes: 'Existing reviewed exemption #2' } : row);
  const sourceRow = name => PAYROLL_REGISTER_COLUMNS.map(({ key }) => {
    if (key === 'employee_name') return name;
    if (key === 'pf' || key === 'esi') return 0;
    if (key === 'salary' || key === 'earned_salary' || key === 'gross_salary' || key === 'net_pay_salary') return 95000;
    return '';
  });
  await grid.import(workbookFile([PAYROLL_REGISTER_COLUMNS.map(column => column.label), sourceRow('Person 01'), sourceRow('Person 02')], 'original-payroll.xlsx'));
  assert.ok(grid.preview());
  assert.ok(grid.field('Import approval note'));
  assert.equal(grid.button('Apply 2 rows to worksheet').props.disabled, true);
  grid.change('Import approval note', '  ');
  assert.equal(grid.button('Apply 2 rows to worksheet').props.disabled, true);
  grid.change('Import approval note', 'Reviewed imported statutory overrides #1');
  assert.equal(grid.button('Apply 2 rows to worksheet').props.disabled, false);
  assert.equal(grid.mutation.calls.length, 0);
  grid.click('Apply 2 rows to worksheet');
  assert.equal(grid.cell(1).props.value, '100', 'computed salary columns and blank inputs do not replace existing incentives');
  grid.click('Hours & deductions');
  assert.equal(grid.cell(1, 'PF').props.value, '0');
  assert.equal(grid.cell(2, 'PF').props.value, '0');
  assert.equal(grid.cell(1, 'Notes / deduction reason').props.value, 'Reviewed imported statutory overrides #1');
  assert.equal(grid.cell(2, 'Notes / deduction reason').props.value, 'Existing reviewed exemption #2');
  await grid.click('Save 2 changes');
  const rows = grid.mutation.writes[0].rows;
  assert.deepEqual(rows.map(row => [row.input.pf, row.input.esi, row.input.notes]), [
    ['0', '0', 'Reviewed imported statutory overrides #1'], ['0', '0', 'Existing reviewed exemption #2'],
  ]);
  assert.ok(rows.every(row => !Object.hasOwn(row.input, 'salary') && !Object.hasOwn(row.input, 'gross_salary')));
});

test('one Excel currency cell is normalized while ordinary note pastes keep native editing', () => {
  const grid = mount({ count: 2 });
  assert.equal(grid.paste(1, '₹1,250.50'), true);
  assert.equal(grid.cell(1).props.value, '1250.5');
  assert.equal(grid.paste(1, 'Approved by finance', 'Notes / deduction reason'), false);
  assert.equal(grid.paste(1, '1,25'), true);
  assert.equal(grid.cell(1).props.value, '1250.5');
  assert.match(text(grid.render()), /Invalid number grouping/);
});

test('automatic punch hours refresh without creating a manual override or an unsaved draft', async () => {
  const grid = mount({ count: 3 }); grid.click('Hours & deductions');
  assert.equal(grid.cell(1, 'OT hours').props.value, '4.5');
  assert.equal(grid.cell(1, 'OT hours').props.readOnly, true);
  assert.equal(grid.cell(1, 'Late hours').props.value, '0.5');
  grid.attendance.data[0] = { ...grid.attendance.data[0], recorded_ot_hours: 6, deductible_late_hours: 1 };
  assert.equal(grid.cell(1, 'OT hours').props.value, '6');
  assert.equal(grid.cell(1, 'Late hours').props.value, '1');
  assert.equal(grid.button('Save changes').props.disabled, true);
  grid.click('Earnings'); grid.edit(1, '250');
  await grid.click('Save 1 changes');
  assert.equal(grid.mutation.writes[0].rows[0].input.ot_hours, '');
  assert.equal(grid.query.data.find(row => row.employee_id === 'employee-1').ot_hours, null);
});

test('HR can override automatic hours including zero, must provide a reason, and can restore automatic hours', async () => {
  const grid = mount({ count: 3 }); grid.click('Hours & deductions');
  grid.click('Person 01 · Override OT hours');
  assert.equal(grid.cell(1, 'OT hours').props.readOnly, false);
  assert.equal(grid.button('Save 1 changes').props.disabled, true);
  grid.edit(1, '0', 'OT hours'); grid.edit(1, 'OT not approved for this month', 'Notes / deduction reason');
  grid.attendance.data[0].recorded_ot_hours = 8;
  assert.equal(grid.cell(1, 'OT hours').props.value, '0');
  await grid.click('Save 1 changes');
  assert.equal(grid.query.data.find(row => row.employee_id === 'employee-1').ot_hours, 0);
  grid.click('Person 01 · Use automatic OT hours');
  assert.equal(grid.cell(1, 'OT hours').props.value, '8');
  assert.equal(grid.cell(1, 'OT hours').props.readOnly, true);
  await grid.click('Save 1 changes');
  assert.equal(grid.query.data.find(row => row.employee_id === 'employee-1').ot_hours, null);
});

test('bulk return to punch hours is reviewed and preserves saved numeric overrides until applied', async () => {
  const grid = mount({ count: 3 });
  grid.query.data[0] = { ...grid.query.data[0], ot_hours: 0, late_hours: 0, notes: 'Reviewed waiver' };
  grid.click('Hours & deductions'); grid.select(1); grid.click('Use punch hours');
  assert.match(text(grid.preview()), /Auto from attendance/);
  assert.equal(grid.cell(1, 'OT hours').props.value, '0');
  grid.click('Apply 1 rows to worksheet');
  assert.equal(grid.cell(1, 'OT hours').props.value, '4.5');
  assert.equal(grid.cell(1, 'Late hours').props.value, '0.5');
  await grid.click('Save 1 changes');
  assert.equal(grid.query.data.find(row => row.employee_id === 'employee-1').late_hours, null);
});

test('attendance refresh failures block writes, processing gaps are visible and disabled late deductions yield zero', () => {
  const grid = mount({ count: 3 }); grid.click('Hours & deductions');
  grid.attendance.data[0].policy_deduct_late = false;
  assert.equal(grid.cell(1, 'Late hours').props.value, '0');
  grid.attendance.data[0].pending_recompute_days = 2;
  assert.match(text(grid.render()), /2 days awaiting attendance processing/);
  grid.change('Filter input status', 'issues');
  assert.ok(grid.cell(1, 'OT hours')); assert.equal(grid.cell(2, 'OT hours'), null);
  grid.attendance.error = new Error('Attendance refresh unavailable');
  assert.equal(grid.cell(1, 'OT hours').props.disabled, true);
  assert.equal(grid.button('Person 01 · Override OT hours').props.disabled, true);
  grid.cell(1, 'OT hours').props.onChange({ target: { value: '12' } });
  assert.equal(grid.cell(1, 'OT hours').props.value, '4.5');
  assert.match(text(grid.render()), /Attendance refresh unavailable/);
});

test('daily punch links retain employee and month and respect attendance access', () => {
  const grid = mount({ count: 3 });
  grid.click('Hours & deductions');
  let links = findAll(grid.render(), node => node.type === 'a');
  assert.equal(links[0].props.to, '/attendance/person?employee=employee-1&period=2026-10');
  grid.canReadAttendance = false;
  links = findAll(grid.render(), node => node.type === 'a');
  assert.equal(links.length, 0);
});

test('saved hour issues require attention while employees outside the month show a neutral status', () => {
  const grid = mount({ count: 3 }); grid.click('Hours & deductions');
  grid.attendance.data[0].override_issue = 'OT override exceeds recorded overtime.';
  grid.attendance.data[1].in_payroll_month = false;
  assert.match(text(grid.render()), /OT override exceeds recorded overtime/);
  assert.match(text(grid.render()), /Outside payroll month/);
  assert.equal(grid.cell(2, 'OT hours').props.disabled, true);
  assert.equal(grid.cell(2, 'OT hours').props.placeholder, 'Not applicable');
  grid.change('Filter input status', 'issues');
  assert.ok(grid.cell(1, 'OT hours')); assert.equal(grid.cell(2, 'OT hours'), null);
});

test('typing AUTO into a manual hour input returns it to attendance mode', () => {
  const grid = mount({ count: 3 }); grid.click('Hours & deductions');
  grid.click('Person 01 · Override OT hours'); grid.edit(1, 'AUTO', 'OT hours');
  assert.equal(grid.cell(1, 'OT hours').props.readOnly, true);
  assert.equal(grid.cell(1, 'OT hours').props.value, '4.5');
  assert.equal(grid.button('Save changes').props.disabled, true);
});

test('published hours display the frozen payroll register and never use changing live attendance', () => {
  const grid = mount({ count: 3, published: true });
  grid.props.snapshots = [{ employee_id: 'employee-1', payroll_register: {
    total_working_hours: 200, recorded_ot_hours: 3, recorded_late_hours: 1,
    recorded_deductible_late_hours: 0.5, ot_hours: 3, late_hours: 0.5, policy: { deduct_late: true },
  } }];
  grid.click('Hours & deductions');
  assert.equal(grid.attendanceOptions.enabled, false);
  assert.equal(grid.cell(1, 'OT hours').props.value, '3');
  grid.attendance.data[0].recorded_ot_hours = 50;
  assert.equal(grid.cell(1, 'OT hours').props.value, '3');
  assert.equal(grid.button('Person 01 · Override OT hours'), null);
  assert.equal(grid.cell(1, 'OT hours').props.disabled, true);
  assert.match(text(grid.render()), /Published snapshot/);
});
