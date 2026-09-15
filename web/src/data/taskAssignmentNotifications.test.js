import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers/promises';

const stubs = {
  '@tanstack/react-query': `export const useQuery = options => globalThis.taskAssignmentHarness?.query(options) ?? options;
    export const useMutation = options => globalThis.taskAssignmentHarness.mutation(options);
    export const useQueryClient = () => ({ invalidateQueries: options => globalThis.taskAssignmentHarness.invalidations.push(options.queryKey) });`,
  react: `export const useMemo = fn => fn(); export const useCallback = fn => fn;
    export const useRef = value => globalThis.taskAssignmentHarness.ref(value);
    export const useEffect = (fn, deps) => globalThis.taskAssignmentHarness.effect(fn, deps);`,
  supabaseClient: 'export const supabase = { from: (...args) => globalThis.taskAssignmentDb.from(...args) };',
};
registerHooks({
  resolve(specifier, context, next) {
    const key = specifier in stubs ? specifier : specifier.split('/').at(-1).replace(/\.jsx?$/, '');
    if (stubs[key]) return { url: `data:text/javascript,${encodeURIComponent(stubs[key])}`, shortCircuit: true };
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const url = new URL(`${specifier}.js`, context.parentURL);
      if (existsSync(fileURLToPath(url))) return next(url.href, context);
    }
    return next(specifier, context);
  },
});

const { useUnreadTaskAssignments, useReadTaskAssignment } = await import('./notifications.js');

function fixtureDb(rows, { failAtOffset = Infinity, beforeWrite } = {}) {
  const reads = [], writes = [];
  globalThis.taskAssignmentDb = {
    from(table) {
      assert.equal(table, 'notifications');
      const filters = [], ordering = [];
      let offset = 0, end = Infinity, patch;
      const query = {
        select() { return query; },
        eq(column, value) { filters.push(row => row[column] === value); return query; },
        in(column, values) { filters.push(row => values.includes(row[column])); return query; },
        is(column, value) { filters.push(row => row[column] === value); return query; },
        order(column, options = {}) { ordering.push([column, options.ascending !== false]); return query; },
        update(value) { patch = value; return query; },
        range(from, to) { offset = from; end = to; return query; },
        then(resolve, reject) {
          const matched = rows.filter(row => filters.every(predicate => predicate(row)));
          if (patch) {
            writes.push({ ids: matched.map(row => row.id), patch });
            return (async () => {
              const error = await beforeWrite?.(writes.length);
              if (error) return { error };
              matched.forEach(row => Object.assign(row, patch));
              return { data: matched.map(row => ({ id: row.id })) };
            })().then(resolve, reject);
          }
          reads.push({ offset, ordering });
          if (offset >= failAtOffset) return Promise.resolve({ error: new Error('Assignment access was revoked') }).then(resolve, reject);
          const data = matched.sort((a, b) => {
            for (const [column, ascending] of ordering) {
              if (a[column] !== b[column]) return (a[column] < b[column] ? -1 : 1) * (ascending ? 1 : -1);
            }
            return 0;
          }).slice(offset, Math.min(end + 1, offset + 17)).map(row => ({ ...row }));
          return Promise.resolve({ data }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  return { reads, writes };
}

const assignment = (id, taskId = id, title = 'New task assigned') => ({
  id, ref_id: taskId, title, type: 'task', read_at: null, created_at: '2026-09-10T10:00:00Z',
});

test('assignment totals cover every unread primary and secondary assignment beyond the bell and server limits', async () => {
  const wanted = Array.from({ length: 125 }, (_, index) => assignment(`assignment-${String(index).padStart(3, '0')}`,
    `task-${index}`, index % 2 ? 'You were added to a task' : 'New task assigned'));
  const unrelated = [
    { ...assignment('already-read'), read_at: '2026-09-11T10:00:00Z' },
    assignment('update', 'task-update', 'Task updated'),
    assignment('complete', 'task-complete', 'Task completed'),
    { ...assignment('wrong-type'), type: 'message' },
  ];
  const db = fixtureDb([...wanted, ...unrelated]);
  const query = useUnreadTaskAssignments();
  assert.deepEqual(query.queryKey, ['notifications', 'task-assignments']);
  assert.equal(query.enabled, true);
  assert.equal(useUnreadTaskAssignments({ enabled: false }).enabled, false);
  assert.deepEqual(await query.queryFn(), wanted);
  assert.ok(db.reads.length > 7, 'all server pages must be loaded');
  assert.ok(db.reads.every(read => read.ordering.at(-1)?.[0] === 'id'));
  assert.equal(db.writes.length, 0, 'counting assignments must not mark them read');
});

test('a later assignment page failure is reported instead of returning an understated count', async () => {
  fixtureDb(Array.from({ length: 125 }, (_, i) => assignment(`assignment-${i}`)), { failAtOffset: 50 });
  await assert.rejects(useUnreadTaskAssignments().queryFn(), /access was revoked/);
});

function hookHarness(data) {
  const refs = [], effects = [];
  let refIndex = 0, effectIndex = 0, pendingEffects = [], mutationOptions;
  const harness = {
    result: { data, isSuccess: true, dataUpdatedAt: 1 }, invalidations: [], queries: [], mutationCalls: [],
    query(options) { this.queries.push(options); return this.result; },
    mutation(options) { mutationOptions = options; return { mutate }; },
    ref(value) { const index = refIndex++; return refs[index] ??= { current: value }; },
    effect(fn, deps) {
      const index = effectIndex++;
      if (!effects[index] || deps.some((value, i) => !Object.is(value, effects[index][i]))) pendingEffects.push(fn);
      effects[index] = deps;
    },
    render: function useAssignmentRender(taskId, open) {
      refIndex = 0; effectIndex = 0; pendingEffects = [];
      useReadTaskAssignment(taskId, open);
      pendingEffects.forEach(fn => fn());
    },
  };
  function mutate(ids, callbacks = {}) {
    harness.mutationCalls.push(ids);
    mutationOptions.mutationFn(ids).then(result => {
      mutationOptions.onSuccess?.(result, ids);
      callbacks.onSuccess?.(result, ids);
    }, error => {
      mutationOptions.onError?.(error, ids);
      callbacks.onError?.(error, ids);
    });
  }
  globalThis.taskAssignmentHarness = harness;
  return harness;
}

test('only opened task details acknowledge matching assignments; cache rerenders never repeat the write', async () => {
  const rows = [assignment('assignment-a', 'task-1'), assignment('assignment-b', 'task-2'),
    assignment('assignment-c', 'task-1', 'You were added to a task')];
  const db = fixtureDb(rows);
  const harness = hookHarness(rows.map(row => ({ ...row })));
  try {
    harness.render('task-1', false);
    assert.equal(harness.queries.at(-1).enabled, false);
    assert.deepEqual(harness.mutationCalls, []);
    harness.render('task-1', true);
    harness.render('task-1', true);
    await setImmediate();
    assert.deepEqual(db.writes.map(write => write.ids), [['assignment-a', 'assignment-c']]);
    assert.equal(rows.find(row => row.id === 'assignment-b').read_at, null, 'another task remains unread');
    assert.deepEqual(harness.invalidations, [['notifications']]);

    // A stale query snapshot can survive a successful write until invalidation resolves.
    harness.result = { ...harness.result, dataUpdatedAt: 2 };
    harness.render('task-1', true);
    await setImmediate();
    assert.equal(db.writes.length, 1);

    harness.render('task-2', true);
    await setImmediate();
    assert.deepEqual(db.writes.at(-1).ids, ['assignment-b']);
    harness.result = { data: [], isSuccess: true, dataUpdatedAt: 3 };
    harness.render('task-2', true);
    harness.render('task-2', false);
    harness.render('task-2', true);
    await setImmediate();
    assert.equal(db.writes.length, 2, 'read assignments are not written again when details reopen');
  } finally {
    delete globalThis.taskAssignmentHarness;
  }
});

test('opening a task without an unread assignment does not acknowledge unrelated notifications', async () => {
  const db = fixtureDb([assignment('unrelated', 'other-task')]);
  const harness = hookHarness([assignment('unrelated', 'other-task')]);
  try {
    harness.render('viewed-task', true);
    await setImmediate();
    assert.deepEqual(db.writes, []);
  } finally {
    delete globalThis.taskAssignmentHarness;
  }
});

test('a failed acknowledgment retries after a fresh snapshot without looping on mutation renders', async () => {
  const rows = [assignment('assignment-a', 'task-1')];
  const db = fixtureDb(rows, { beforeWrite: number => number === 1 ? new Error('Temporarily offline') : null });
  const harness = hookHarness(rows.map(row => ({ ...row })));
  try {
    harness.render('task-1', true);
    await setImmediate();
    assert.equal(rows[0].read_at, null);
    harness.render('task-1', true);
    await setImmediate();
    assert.equal(db.writes.length, 1, 'mutation errors alone cannot cause a retry loop');
    harness.result = { ...harness.result, dataUpdatedAt: 2 };
    harness.render('task-1', true);
    await setImmediate();
    assert.equal(db.writes.length, 2, 'a fresh successful snapshot retries a failed acknowledgment');
    assert.ok(rows[0].read_at);
    harness.result = { ...harness.result, dataUpdatedAt: 3 };
    harness.render('task-1', true);
    await setImmediate();
    assert.equal(db.writes.length, 2, 'successful acknowledgment remains deduplicated until cache refresh');
  } finally {
    delete globalThis.taskAssignmentHarness;
  }
});

test('failure from an older details session cannot unlock a newer in-flight acknowledgment', async () => {
  let finishFirst, finishSecond;
  const first = new Promise(resolve => { finishFirst = resolve; });
  const second = new Promise(resolve => { finishSecond = resolve; });
  const rows = [assignment('assignment-a', 'task-1')];
  const db = fixtureDb(rows, { beforeWrite: number => number === 1 ? first : second });
  const harness = hookHarness(rows.map(row => ({ ...row })));
  try {
    harness.render('task-1', true);
    await setImmediate();
    harness.render('task-1', false);
    harness.render('task-1', true);
    await setImmediate();
    assert.equal(db.writes.length, 2);
    finishFirst(new Error('First session lost its connection'));
    await setImmediate();
    harness.result = { ...harness.result, dataUpdatedAt: 2 };
    harness.render('task-1', true);
    await setImmediate();
    assert.equal(db.writes.length, 2, 'the second acknowledgment is still in flight');
    finishSecond(null);
    await setImmediate();
    assert.ok(rows[0].read_at);
  } finally {
    finishFirst(null);
    finishSecond(null);
    delete globalThis.taskAssignmentHarness;
  }
});

test('missing task ids and failed assignment snapshots cannot acknowledge unread rows', async () => {
  const db = fixtureDb([assignment('assignment-a', 'task-1')]);
  const harness = hookHarness([assignment('assignment-a', 'task-1')]);
  try {
    harness.render(null, true);
    assert.equal(harness.queries.at(-1).enabled, false);
    harness.result = { ...harness.result, isSuccess: false };
    harness.render('task-1', true);
    await setImmediate();
    assert.deepEqual(db.writes, []);
  } finally {
    delete globalThis.taskAssignmentHarness;
  }
});
