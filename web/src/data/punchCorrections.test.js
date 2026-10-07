import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const calls = [], invalidated = [];
let response;
globalThis.punchCorrectionTest = { rpc: async (name, args) => { calls.push({ name, args }); return response; },
  invalidate: async args => { invalidated.push(args.queryKey); } };
const stubs = {
  '@tanstack/react-query': `export const useQuery=x=>x; export const useMutation=x=>x;
    export const useQueryClient=()=>({invalidateQueries:globalThis.punchCorrectionTest.invalidate});`,
  '../lib/supabaseClient': 'export const supabase={rpc: (...args)=>globalThis.punchCorrectionTest.rpc(...args)};',
};
const loader = registerHooks({ resolve(specifier, context, next) {
  return stubs[specifier] ? { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true } : next(specifier, context);
} });
const { usePunchCorrectionContext, useSavePunchCorrection } = await import('./punchCorrections.js');
after(() => { loader.deregister(); delete globalThis.punchCorrectionTest; });

test('correction context requires the selected employee and day, keeps errors visible and polls processing', async () => {
  assert.equal(usePunchCorrectionContext('', '2026-09-15').enabled, false);
  assert.equal(usePunchCorrectionContext('employee', '2026-02-30').enabled, false);
  const query = usePunchCorrectionContext('employee', '2026-09-15');
  assert.equal(query.meta.persist, false);
  assert.equal(query.refetchInterval({ state: { data: { pending_recompute: true } } }), 3000);
  response = { data: { employee_id: 'employee', work_date: '2026-09-15', source_revision: 'reviewed', can_correct: true }, error: null };
  assert.deepEqual(await query.queryFn(), response.data);
  response = { data: { ...response.data, employee_id: 'other' }, error: null };
  await assert.rejects(query.queryFn(), /could not be loaded/);
  response = { data: null, error: new Error('Outside correction scope') };
  await assert.rejects(query.queryFn(), /Outside correction scope/);
});

test('HR save sends only a Supabase correction, preserves retry identity and converts overnight times to IST', async () => {
  calls.length = 0;
  response = { data: { correction_id: 'request', recompute_pending: true }, error: null };
  const mutation = useSavePunchCorrection();
  const input = { requestId: 'request', employeeId: 'employee', workDate: '2026-09-15', checkIn: '',
    checkOut: '06:00', checkOutNextDay: true, reason: '  Missed checkout  ', sourceRevision: 'reviewed' };
  await mutation.mutationFn(input);
  await mutation.mutationFn(input);
  assert.deepEqual(calls[0], { name: 'save_attendance_punch_correction', args: {
    _request_id: 'request', _employee_id: 'employee', _work_date: '2026-09-15',
    _check_in: null, _check_out: '2026-09-16T00:30:00.000Z', _reason: 'Missed checkout', _source_revision: 'reviewed',
  } });
  assert.deepEqual(calls[1], calls[0]);
  for (const change of [{ requestId: '' }, { employeeId: '' }, { sourceRevision: '' }, { reason: ' ' }, { checkOut: '' },
    { checkIn: '22:00', checkOutNextDay: false }]) await assert.rejects(mutation.mutationFn({ ...input, ...change }));
  assert.equal(calls.length, 2, 'invalid corrections never reach Supabase');
  response = { data: null, error: new Error('Punches changed; reload this day') };
  await assert.rejects(mutation.mutationFn(input), /Punches changed/);
  response = { data: null, error: null };
  await assert.rejects(mutation.mutationFn(input), /Retry this same correction/);
});

test('save refreshes attendance, correction history and payroll; failed save refreshes only its evidence', async () => {
  invalidated.length = 0;
  const mutation = useSavePunchCorrection();
  await mutation.onSuccess();
  for (const key of ['attendance-punch-correction', 'attendance', 'regularizations', 'payroll-attendance-summary',
    'payroll-worksheet-run', 'payroll-register']) assert.ok(invalidated.some(parts => parts[0] === key), key);
  invalidated.length = 0;
  await mutation.onError(new Error('Conflict'), { employeeId: 'employee', workDate: '2026-09-15' });
  assert.deepEqual(invalidated, [['attendance-punch-correction', 'employee', '2026-09-15']]);
});
