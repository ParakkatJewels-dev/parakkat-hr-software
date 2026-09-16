import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { QueryClient, QueryObserver } from '@tanstack/query-core';

const stubs = {
  '@tanstack/react-query': 'export const useQuery = options => options; export const useMutation = options => options; export const useQueryClient = () => globalThis.leaveAllocationAudit.client;',
  supabaseClient: 'export const supabase = { from: (...args) => globalThis.leaveAllocationAudit.from(...args), rpc: (...args) => globalThis.leaveAllocationAudit.rpc(...args) };',
  AuthContext: 'export const useAuth = () => ({});',
};
const loader = registerHooks({ resolve(specifier, context, next) {
  const key = specifier in stubs ? specifier : specifier.split('/').at(-1).replace(/\.jsx?$/, '');
  if (stubs[key]) return { url: `data:text/javascript,${encodeURIComponent(stubs[key])}`, shortCircuit: true };
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(`${specifier}.js`, context.parentURL);
    if (existsSync(fileURLToPath(url))) return next(url.href, context);
  }
  return next(specifier, context);
} });
const holidays = await import('./holidays.js');
const shifts = await import('./shifts.js');
const org = await import('./org.js');
const employees = await import('./employees.js');
after(() => { loader.deregister(); delete globalThis.leaveAllocationAudit; });

const allocationKey = ['leaves-period-days', '2026-09-01', '2026-09-30'];
const olderAllocationKey = ['leaves-period-days', '2026-08-01', '2026-08-31'];
function harness(error = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(allocationKey, [{ leave_id: 'leave-one', period_days: 3 }]);
  client.setQueryData(olderAllocationKey, [{ leave_id: 'leave-older', period_days: 4 }]);
  client.setQueryData(['jobs'], []);
  let reads = 0;
  const observer = new QueryObserver(client, { queryKey: allocationKey, staleTime: Infinity,
    queryFn: async () => { reads++; return [{ leave_id: 'leave-one', period_days: 2 }]; } });
  const unsubscribe = observer.subscribe(() => {});
  const result = { data: { id: 'saved-one' }, error };
  globalThis.leaveAllocationAudit = { client,
    from() { return { insert() { return this; }, update() { return this; }, delete() { return this; },
      eq() { return this; }, select() { return this; }, single() { return this; },
      then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); } }; },
    rpc: async () => result,
  };
  return { client, reads: () => reads, execute(options, variables) {
    return client.getMutationCache().build(client, options).execute(variables);
  }, close() { unsubscribe(); client.clear(); } };
}
const cases = [
  ['holiday creation', () => holidays.useSaveHoliday(), { calendar_id: 'calendar', holiday_date: '2026-09-03', name: 'Holiday' }],
  ['holiday edit', () => holidays.useSaveHoliday(), { id: 'holiday', calendar_id: 'calendar', holiday_date: '2026-09-03', name: 'Holiday', is_optional: true }],
  ['holiday deletion', () => holidays.useDeleteHoliday(), 'holiday'],
  ['calendar default change', () => holidays.useSaveCalendar(), { id: 'calendar', entity_id: 'entity', code: 'CAL', name: 'Calendar', is_default: true }],
  ['shift weekly-off change', () => shifts.useSaveShift(), { id: 'shift', code: 'DAY', name: 'Day', start_time: '09:00', end_time: '17:00', weekly_offs: [0, 6] }],
  ['shift deletion', () => shifts.useDeleteShift(), 'shift'],
  ['effective shift assignment', () => shifts.useAssignShift(), { employeeId: 'employee', shiftId: 'shift', effectiveFrom: '2026-09-01' }],
  ['branch calendar change', () => org.useOrgMutation(), { table: 'branches', op: 'update', row: { id: 'branch', holiday_calendar_id: 'calendar' } }],
  ['employee branch change', () => employees.useUpdateEmployee(), { id: 'employee', branch_id: 'branch' }],
  ['employee company change', () => employees.useUpdateEmployee(), { id: 'employee', entity_id: 'entity' }],
];
for (const [label, options, variables] of cases) test(`${label} refreshes mounted leave allocations and marks other periods stale`, async () => {
  const h = harness();
  try {
    assert.equal(h.reads(), 0);
    await h.execute(options(), variables);
    assert.equal(h.reads(), 1);
    assert.deepEqual(h.client.getQueryData(allocationKey), [{ leave_id: 'leave-one', period_days: 2 }]);
    assert.equal(h.client.getQueryState(olderAllocationKey).isInvalidated, true);
    assert.equal(h.client.getQueryState(['jobs']).isInvalidated, false);
  } finally { h.close(); }
});

test('failed calendar, shift and placement writes do not publish a new report allocation', async () => {
  for (const [, options, variables] of cases) {
    const h = harness({ code: '42501', message: 'Write denied' });
    try {
      await assert.rejects(h.execute(options(), variables), error => error.message === 'Write denied');
      assert.equal(h.reads(), 0);
      assert.equal(h.client.getQueryState(olderAllocationKey).isInvalidated, false);
      assert.deepEqual(h.client.getQueryData(allocationKey), [{ leave_id: 'leave-one', period_days: 3 }]);
    } finally { h.close(); }
  }
});

test('unrelated organization and employee edits do not recompute working days', async () => {
  for (const [options, variables] of [
    [() => org.useOrgMutation(), { table: 'designations', op: 'update', row: { id: 'designation', title: 'Senior' } }],
    [() => employees.useUpdateEmployee(), { id: 'employee', phone: '12345' }],
  ]) {
    const h = harness();
    try { await h.execute(options(), variables); assert.equal(h.reads(), 0); }
    finally { h.close(); }
  }
});
