import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const stubs = {
  '@tanstack/react-query': `export const useQuery = x => x;
    export const useMutation = x => ({ ...x, mutateAsync: async value => {
      const result = await x.mutationFn(value); await x.onSuccess?.(result, value); return result;
    } });
    export const useQueryClient = () => ({ invalidateQueries: x => globalThis.leaveWorkflowInvalidations?.push(x.queryKey) });`,
  supabaseClient: `export const supabase = {
    from: (...args) => globalThis.leaveWorkflowDb.from(...args),
    rpc: (...args) => globalThis.leaveWorkflowDb.rpc(...args),
  };`,
};
registerHooks({
  resolve(specifier, context, next) {
    const key = specifier in stubs ? specifier : specifier.split('/').at(-1).replace(/\.js$/, '');
    if (stubs[key]) return { url: `data:text/javascript,${encodeURIComponent(stubs[key])}`, shortCircuit: true };
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const url = new URL(`${specifier}.js`, context.parentURL);
      if (existsSync(fileURLToPath(url))) return next(url.href, context);
    }
    return next(specifier, context);
  },
});
const { useDecideLeave, useLeaveDecisions } = await import('./leaves.js');

test('leave decisions require bounded remarks and send trimmed notes through the stage-aware RPC', async () => {
  const calls = [];
  const forwarded = { id: 'leave-1', status: 'Pending', approval_stage: 'hr' };
  globalThis.leaveWorkflowDb = {
    from() { assert.fail('leave decisions must not write status directly'); },
    async rpc(name, input) { calls.push({ name, input }); return { data: forwarded }; },
  };
  const mutation = useDecideLeave();
  for (const remarks of [undefined, null, '', ' \n\t ', 'x'.repeat(2001)]) {
    await assert.rejects(mutation.mutationFn({ id: 'leave-1', status: 'Approved', remarks }), /remarks/i);
  }
  assert.equal(calls.length, 0, 'invalid remarks never reach the server');
  for (const status of ['Approved', 'Rejected', 'On Hold', 'Pending', 'Cancelled']) {
    assert.deepEqual(await mutation.mutationFn({ id: 'leave-1', status, remarks: '  Coverage confirmed.\n  ' }), forwarded);
    assert.deepEqual(calls.at(-1), { name: 'decide_leave', input: {
      _leave_id: 'leave-1', _decision: status, _remarks: 'Coverage confirmed.',
    } });
  }
  await mutation.mutationFn({ id: 'leave-1', status: 'Approved', remarks: 'x'.repeat(2000) });
  assert.equal(calls.at(-1).input._remarks.length, 2000, 'the documented maximum is accepted');
});

test('successful decisions refresh leave lists, paged history, balances, attendance and notifications', async () => {
  globalThis.leaveWorkflowInvalidations = [];
  globalThis.leaveWorkflowDb = { async rpc() { return { data: { status: 'Approved', approval_stage: 'completed' } }; } };
  try {
    await useDecideLeave().mutateAsync({ id: 'leave-1', status: 'Approved', remarks: 'HR sanction granted' });
    const keys = globalThis.leaveWorkflowInvalidations;
    for (const key of ['leaves', 'leaves-period', 'leave-balances', 'attendance', 'notifications', 'notification-ref-statuses']) {
      assert.ok(keys.some(prefix => prefix[0] === key), `${key} refreshes after a decision`);
    }
    const historyKey = useLeaveDecisions('leave-1', 3, 10).queryKey;
    assert.ok(keys.some(prefix => prefix.every((part, index) => part === historyKey[index])), 'history pages share an invalidated prefix');
  } finally {
    delete globalThis.leaveWorkflowInvalidations;
  }
});

test('a stale stage or scope error is preserved and cannot trigger successful cache invalidation', async () => {
  const error = { code: '42501', message: 'Only the current department/HR reviewer can decide this leave.' };
  globalThis.leaveWorkflowInvalidations = [];
  globalThis.leaveWorkflowDb = { async rpc() { return { error }; } };
  try {
    await assert.rejects(useDecideLeave().mutateAsync({ id: 'leave-1', status: 'Approved', remarks: 'Outdated stage' }), result => result === error);
    assert.deepEqual(globalThis.leaveWorkflowInvalidations, []);
  } finally {
    delete globalThis.leaveWorkflowInvalidations;
  }
});

function historyDb(rows, { cap = 3, failAt = Infinity } = {}) {
  const calls = [];
  globalThis.leaveWorkflowDb = {
    from(table) {
      assert.equal(table, 'leave_decisions');
      let fields, options, leaveId, start, end;
      const order = [];
      const query = {
        select(value, config) { fields = value; options = config; return query; },
        eq(column, value) { assert.equal(column, 'leave_id'); leaveId = value; return query; },
        order(column, config = {}) { order.push([column, config.ascending !== false]); return query; },
        range(from, to) { start = from; end = to; return query; },
        then(resolve, reject) {
          calls.push({ fields, options, leaveId, start, end, order });
          if (calls.length >= failAt) return Promise.resolve({ error: new Error('Leave history access changed') }).then(resolve, reject);
          const scoped = rows.filter(row => row.leave_id === leaveId).sort((a, b) => {
            for (const [column, ascending] of order) {
              if (a[column] !== b[column]) return (a[column] < b[column] ? -1 : 1) * (ascending ? 1 : -1);
            }
            return 0;
          });
          return Promise.resolve({ data: scoped.slice(start, Math.min(end + 1, start + cap)), count: scoped.length }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  return calls;
}

const history = Array.from({ length: 37 }, (_, i) => ({
  id: `decision-${String(i).padStart(3, '0')}`, leave_id: 'leave-1', created_at: '2026-09-15T10:00:00Z',
  stage: i % 2 ? 'hr' : 'department', decision: 'Approved', remarks: `Review ${i}`, actor_name: 'Reviewer',
}));
history.push({ id: 'unrelated-newest', leave_id: 'leave-2', created_at: '2026-09-16T10:00:00Z' });

test('decision history uses exact counts and stable scoped server pages despite timestamp ties and a low API cap', async () => {
  const expected = history.filter(row => row.leave_id === 'leave-1').reverse();
  for (const cap of [1, 3]) {
    for (const [page, count] of [[1, 10], [2, 10], [4, 7], [5, 0]]) {
      const calls = historyDb(history, { cap });
      const query = useLeaveDecisions('leave-1', page, 10);
      assert.deepEqual(query.queryKey, ['leaves', 'decisions', 'leave-1', page, 10]);
      const result = await query.queryFn();
      assert.equal(result.count, 37, 'exact total excludes another request history');
      assert.equal(result.rows.length, count);
      assert.deepEqual(result.rows, expected.slice((page - 1) * 10, page * 10));
      assert.ok(calls.every(call => call.leaveId === 'leave-1' && call.options.count === 'exact'));
      assert.ok(calls.every(call => call.start >= (page - 1) * 10 && call.end < page * 10));
      assert.ok(calls.every(call => JSON.stringify(call.order) === JSON.stringify([['created_at', false], ['id', false]])));
      assert.ok(calls.every(call => ['stage', 'decision', 'remarks', 'actor_name', 'from_stage', 'to_stage'].every(field => call.fields.includes(field))));
    }
  }
});

test('history is disabled without a leave ID and failed capped continuations do not return incomplete decisions', async () => {
  assert.equal(useLeaveDecisions(null).enabled, false);
  assert.equal(useLeaveDecisions('leave-1').enabled, true);
  historyDb(history, { cap: 3, failAt: 2 });
  await assert.rejects(useLeaveDecisions('leave-1').queryFn(), /access changed/);
});
