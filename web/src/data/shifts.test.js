import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { shiftFormDraft } from '../lib/shiftForm.js';

const calls = [], invalidations = [];
const loader = registerHooks({ resolve(specifier, context, next) {
  const source = specifier === '@tanstack/react-query'
    ? 'export const useQuery=x=>x; export const useMutation=x=>x; export const useQueryClient=()=>globalThis.shiftHookClient;'
    : specifier === '../lib/supabaseClient'
      ? 'export const supabase = { from: (...args) => globalThis.shiftHookDb.from(...args), rpc: (...args) => globalThis.shiftHookDb.rpc(...args) };'
      : specifier === '../lib/fetchCollection' ? 'export const fetchCollection = () => [];' : null;
  return source ? { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true } : next(specifier, context);
} });
globalThis.shiftHookClient = { invalidateQueries: ({ queryKey }) => { invalidations.push(queryKey[0]); } };
globalThis.shiftHookDb = { from(table) { return { insert(payload) { calls.push({ table, action: 'insert', payload }); return Promise.resolve({ error: null }); },
  update(payload) { return { eq(key, id) { calls.push({ table, action: 'update', payload, key, id }); return Promise.resolve({ error: null }); } }; } }; } };
const { useSaveShift, useAssignEmployeeShifts } = await import('./shifts.js');
after(() => { loader.deregister(); delete globalThis.shiftHookDb; delete globalThis.shiftHookClient; });

test('shift saves include the reviewed night/break rules and keep explicit zero thresholds', async () => {
  const shift = shiftFormDraft({ id: 'night', entity_id: 'company', code: 'NIGHT', name: 'Night shift',
    start_time: '22:00', end_time: '06:30', break_minutes: 40, break_policy: 'excess', full_day_minutes: 510,
    half_day_minutes: 255, is_flexible: false, ot_basis: 'worked', missed_punch_policy: 'present',
    late_absent_minutes: 0, early_absent_minutes: 0, short_day_tolerance_minutes: 0 });
  const mutation = useSaveShift();
  await mutation.mutationFn(shift);
  assert.equal(calls.at(-1).action, 'update');
  assert.equal(calls.at(-1).id, 'night');
  assert.equal(calls.at(-1).payload.break_policy, 'excess');
  assert.equal(calls.at(-1).payload.missed_punch_policy, 'present');
  assert.equal(calls.at(-1).payload.late_absent_minutes, 0);
  assert.equal(calls.at(-1).payload.short_day_tolerance_minutes, 0);
  await mutation.onSuccess();
  for (const key of ['shifts', 'attendance', 'leaves-period-days', 'payroll-attendance-summary', 'payroll-worksheet-run']) assert.ok(invalidations.includes(key));
});

test('invalid shift rule is rejected before any database write', async () => {
  const before = calls.length;
  await assert.rejects(useSaveShift().mutationFn(shiftFormDraft({ code: 'N', name: 'Night', start_time: '22:00', end_time: '06:00', break_minutes: 60, full_day_minutes: 480 })), /420 minutes/);
  assert.equal(calls.length, before);
});


test('scheduled break save sends only clock-window fields and the reviewed salary basis', async () => {
  const shift = shiftFormDraft({ id: 'night', code: 'N', name: 'Night', start_time: '22:00', end_time: '06:30',
    break_policy: 'scheduled', full_day_minutes: 480,
    break_windows: [{ label: 'Night meal', start_time: '02:00', end_time: '02:30', is_paid: false }] });
  await useSaveShift().mutationFn(shift);
  assert.deepEqual(calls.at(-1).payload.break_windows, shift.break_windows);
  assert.equal(calls.at(-1).payload.full_day_minutes, 480);
});

test('selected employee shift assignment sends one atomic RPC and invalidates every affected view', async () => {
  const rpcCalls = [];
  globalThis.shiftHookDb.rpc = async (name, params) => { rpcCalls.push({ name, params }); return { data: { employee_count: 2, assignments: [] }, error: null }; };
  const mutation = useAssignEmployeeShifts();
  const result = await mutation.mutationFn({ employeeIds: ['employee-1', 'employee-2'], shiftId: 'night',
    effectiveFrom: '2026-10-10', effectiveTo: '2026-10-20', note: '  HR-approved night duty  ' });
  assert.equal(result.employee_count, 2);
  assert.deepEqual(rpcCalls, [{ name: 'assign_employee_shifts', params: {
    _employee_ids: ['employee-1', 'employee-2'], _shift_id: 'night', _effective_from: '2026-10-10',
    _effective_to: '2026-10-20', _note: 'HR-approved night duty',
  } }]);
  await mutation.onSuccess();
  for (const key of ['shift-assignments', 'attendance', 'leaves-period-days', 'payroll-attendance-summary', 'payroll-worksheet-run', 'payroll-register', 'payroll-runs', 'payslips']) assert.ok(invalidations.includes(key));
  for (const patch of [{ employeeIds: [] }, { employeeIds: ['employee-1', 'employee-1'] }, { effectiveFrom: '2026-02-30' }, { effectiveTo: '2026-10-09' }]) {
    await assert.rejects(mutation.mutationFn({ employeeIds: ['employee-1'], shiftId: 'night', effectiveFrom: '2026-10-10', ...patch }));
  }
  assert.equal(rpcCalls.length, 1, 'invalid selection does not start a partial batch');
});
