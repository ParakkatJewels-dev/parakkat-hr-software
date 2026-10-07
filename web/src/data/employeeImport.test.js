import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const target = new URL('./employeeImport.js', import.meta.url);
const loader = registerHooks({ resolve(specifier, context, next) {
  return context.parentURL === target.href && specifier === '../lib/supabaseClient'
    ? { url: `data:text/javascript,${encodeURIComponent('export const supabase = { from: (...args) => globalThis.importDb.from(...args), rpc: (...args) => globalThis.importDb.rpc(...args) };')}`, shortCircuit: true }
    : next(specifier, context);
} });
const { detectLayout, extractPeople, planImport, runImport } = await import(target.href);
const shifts = [
  { id: 'company-day', entity_id: 'company', code: 'DAY', name: 'Day duty', is_active: true },
  { id: 'shared-day', entity_id: null, code: 'DAY', name: 'Shared day duty', is_active: true },
  { id: 'night', entity_id: null, code: 'NIGHT', name: 'Night duty', is_active: true },
  { id: 'foreign', entity_id: 'foreign-company', code: 'FOREIGN', name: 'Foreign duty', is_active: true },
  { id: 'inactive', entity_id: 'company', code: 'OLD', name: 'Old duty', is_active: false },
];
const setup = overrides => ({ entityId: 'company', existingByName: new Map(), existingByCode: new Map(),
  branches: new Set(), designations: new Set(), shifts, defaultShiftId: 'company-day', defaultJoinDate: '2026-09-01', ...overrides });
const people = rows => extractPeople([['Employee name', 'Employee code', 'Join date', 'Shift', 'Email'], ...rows],
  detectLayout([['Employee name', 'Employee code', 'Join date', 'Shift', 'Email'], ...rows]));
const calls = [];
let failAt;
beforeEach(() => {
  calls.length = 0; failAt = null;
  globalThis.importDb = {
    from(table) {
      calls.push({ table, action: 'read' });
      const response = { data: [], error: null };
      const query = { select: () => query, eq: () => query, like: () => query,
        then: (resolve, reject) => Promise.resolve(response).then(resolve, reject),
        update(patch) { return { eq: async (key, id) => { calls.push({ table, action: 'update', patch, key, id }); return { error: null }; } }; },
        insert() { throw new Error('Employee import must not insert employees separately from shifts'); },
      };
      return query;
    },
    async rpc(name, args) {
      calls.push({ name, args });
      const number = calls.filter(call => call.name).length;
      return number === failAt ? { error: { message: 'Selected shift was deactivated', code: '23514' } }
        : { data: { id: `created-${number}` }, error: null };
    },
  };
});
after(() => { loader.deregister(); delete globalThis.importDb; });

test('spreadsheet shift code and join-date columns are recognized together', () => {
  const rows = [['Employee Name', 'Shift Code', 'Date of Joining'], ['Synthetic employee', 'NIGHT', '07/10/2026']];
  const [person] = extractPeople(rows, detectLayout(rows));
  assert.equal(person.shift, 'NIGHT');
  assert.equal(person.join_date, '2026-10-07');
});

test('row shift and join date override explicitly selected batch values', () => {
  const plan = planImport(people([['Night employee', '', '2026-08-15', 'night duty', ''], ['Day employee', '', '', '', '']]), setup());
  assert.equal(plan.counts.invalid, 0);
  assert.deepEqual(plan.rows.map(row => [row.initialShiftId, row.resolvedJoinDate]), [['night', '2026-08-15'], ['company-day', '2026-09-01']]);
});

test('company shift codes take priority over shared codes and ambiguous names require a code', () => {
  const row = people([['Synthetic employee', '', '', 'day', '']]);
  assert.equal(planImport(row, setup()).rows[0].initialShiftId, 'company-day');
  row[0].shift = 'Duplicate name';
  const duplicate = [{ ...shifts[0], name: 'Duplicate name' }, { ...shifts[0], id: 'another', code: 'DAY2', name: 'Duplicate name' }];
  assert.match(planImport(row, setup({ shifts: duplicate })).rows[0].setupIssue, /more than one schedule/);
});

test('unknown, inactive and other-company row shifts block the preview instead of using the batch fallback', () => {
  for (const shift of ['UNKNOWN', 'OLD', 'FOREIGN']) {
    const plan = planImport(people([['Synthetic employee', '', '', shift, '']]), setup());
    assert.equal(plan.counts.invalid, 1);
    assert.equal(plan.rows[0].initialShiftId, null);
    assert.match(plan.rows[0].setupIssue, /not an active shift/);
  }
});

test('every new row needs both a chosen shift and an actual join date', () => {
  const rows = people([['Synthetic employee', '', '', '', '']]);
  const missing = planImport(rows, setup({ defaultShiftId: '', defaultJoinDate: '' }));
  assert.equal(missing.counts.invalid, 1);
  assert.match(missing.rows[0].setupIssue, /Choose a shift.*Enter the join date/);
  assert.equal(planImport(rows, setup({ defaultJoinDate: '2026-02-30' })).counts.invalid, 1);
  assert.equal(planImport(rows, setup({ defaultShiftId: 'foreign' })).counts.invalid, 1);
});

test('existing-person updates ignore imported shifts and batch join-date fallback', () => {
  const existing = { id: 'existing', full_name: 'Existing employee', employee_code: 'E1', email: '', join_date: null, initial_shift_id: 'existing-shift' };
  const plan = planImport(people([['Existing employee', 'E1', '', 'UNKNOWN', 'new@example.invalid']]),
    setup({ existingByCode: new Map([['e1', existing]]) }));
  assert.equal(plan.counts.invalid, 0);
  assert.equal(plan.rows[0].status, 'update');
  assert.deepEqual(plan.rows[0].updates, { email: 'new@example.invalid' });
  assert.equal(plan.rows[0].initialShiftId, null);
});

test('invalid new-row setup is rejected before even existing-person updates can write', async () => {
  const plan = planImport(people([['New employee', '', '', '', '']]), setup({ defaultShiftId: '' }));
  plan.rows.unshift({ status: 'update', matchId: 'existing', full_name: 'Existing', _row: 1, updates: { email: 'new@example.invalid' } });
  await assert.rejects(runImport({ entityId: 'company', entityCode: 'CO', rows: plan.rows }), /Row 2.*Choose a shift/);
  assert.deepEqual(calls, []);
});

test('each new employee uses the atomic create RPC with the resolved shift and join date', async () => {
  const plan = planImport(people([['Night employee', 'N1', '2026-08-15', 'NIGHT', ''], ['Day employee', '', '', '', '']]), setup());
  const progress = [];
  const result = await runImport({ entityId: 'company', entityCode: 'CO', rows: plan.rows, createOrg: false,
    onProgress: (...args) => progress.push(args) });
  assert.deepEqual(result, { created: 2, updated: 0, branches: 0, designations: 0 });
  const requests = calls.filter(call => call.name);
  assert.deepEqual(requests.map(call => [call.name, call.args._shift_id, call.args._employee.join_date, call.args._employee.employee_code]), [
    ['create_employee_with_shift', 'night', '2026-08-15', 'N1'], ['create_employee_with_shift', 'company-day', '2026-09-01', 'CO-0001'],
  ]);
  assert.ok(requests.every(call => !('shift' in call.args._employee) && !('initial_shift_id' in call.args._employee)));
  assert.deepEqual(progress, [[1, 2], [2, 2]]);
});

test('a failed employee-and-shift transaction reports exactly which preceding rows were saved', async () => {
  failAt = 2;
  const plan = planImport(people([['First', '', '', '', ''], ['Second', '', '', '', ''], ['Third', '', '', '', '']]), setup());
  const progress = [];
  await assert.rejects(runImport({ entityId: 'company', entityCode: 'CO', rows: plan.rows, createOrg: false,
    onProgress: (...args) => progress.push(args) }), /Created 1 of 3 before failing on row 3.*shift was deactivated/);
  assert.equal(calls.filter(call => call.name).length, 2);
  assert.deepEqual(progress, [[1, 3]]);
});

test('an import containing only existing updates never calls the employee creation or assignment RPC', async () => {
  const row = { status: 'update', matchId: 'existing', full_name: 'Existing', _row: 2, updates: { join_date: '2026-08-01' } };
  assert.deepEqual(await runImport({ entityId: 'company', entityCode: 'CO', rows: [row] }),
    { created: 0, updated: 1, branches: 0, designations: 0 });
  assert.deepEqual(calls.filter(call => call.action === 'update'), [{ table: 'employees', action: 'update', patch: row.updates, key: 'id', id: 'existing' }]);
  assert.equal(calls.some(call => call.name), false);
});
