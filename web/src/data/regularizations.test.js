import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const writes = [];
const invalidated = [];
globalThis.regularizationTest = { writes, invalidated };
const stubs = {
  '@tanstack/react-query': `export const useQuery = x => x; export const useMutation = x => x;
    export const useQueryClient = () => ({ invalidateQueries(x) { globalThis.regularizationTest.invalidated.push(x); } });`,
  '../lib/supabaseClient': `export const supabase = { from: table => ({ insert: async payload => {
    globalThis.regularizationTest.writes.push({ table, payload }); return { error: null };
  } }) };`,
  '../lib/fetchCollection': 'export const fetchCollection = () => [];',
};
const loader = registerHooks({
  resolve(specifier, context, next) {
    return stubs[specifier]
      ? { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true }
      : next(specifier, context);
  },
});
const { useCreateRegularization } = await import('./regularizations.js');
after(() => { loader.deregister(); delete globalThis.regularizationTest; });

test('ATT-05: real mutation inserts explicit overnight and checkout-only corrections with valid order', async () => {
  const mutation = useCreateRegularization();
  for (const checkIn of ['22:00', '']) {
    await mutation.mutationFn({ employeeId: 'test-employee', workDate: '2026-07-15',
      checkIn, checkOut: '06:00', checkOutNextDay: true, reason: 'Missed punch' });
    const { table, payload } = writes.at(-1);
    assert.equal(table, 'attendance_regularizations');
    assert.equal(payload.work_date, '2026-07-15');
    assert.equal(payload.check_in, checkIn ? '2026-07-15T16:30:00.000Z' : null);
    assert.equal(payload.check_out, '2026-07-16T00:30:00.000Z');
    assert.equal(payload.status, 'Pending');
    assert.ok(!payload.check_in || payload.check_out > payload.check_in);
  }
  const previousWrites = writes.length;
  await assert.rejects(() => mutation.mutationFn({ employeeId: 'test-employee', workDate: '2026-07-15',
    checkIn: '22:00', checkOut: '06:00', reason: 'Missing next-day choice' }), /next day/);
  assert.equal(writes.length, previousWrites);
  await mutation.onSuccess();
  assert.deepEqual(invalidated, [{ queryKey: ['regularizations'] }, { queryKey: ['section-counts'] }]);
});
