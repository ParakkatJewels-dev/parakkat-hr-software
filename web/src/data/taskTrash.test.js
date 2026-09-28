import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { QueryClient, QueryObserver } from '@tanstack/query-core';

const stubs = {
  react: 'export const useRef = value => ({ current: value });',
  '@tanstack/react-query': `export const useQuery = value => value; export const useMutation = value => value;
    export const useQueryClient = () => globalThis.taskTrashClient ?? ({ cancelQueries: async () => {},
      invalidateQueries: ({ queryKey }) => globalThis.taskTrashInvalidations.push(queryKey) });`,
  supabaseClient: 'export const supabase = { from: (...args) => globalThis.taskTrashDb.from(...args), rpc: (...args) => globalThis.taskTrashDb.rpc(...args) };',
  AuthContext: 'export const useAuth = () => ({ employee: { id: "me" }, user: { id: "user" } });',
};
registerHooks({ resolve(specifier, context, next) {
  const key = specifier in stubs ? specifier : specifier.split('/').at(-1).replace(/\.jsx?$/, '');
  if (stubs[key]) return { url: `data:text/javascript,${encodeURIComponent(stubs[key])}`, shortCircuit: true };
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(`${specifier}.js`, context.parentURL);
    if (existsSync(fileURLToPath(url))) return next(url.href, context);
  }
  return next(specifier, context);
} });
const { useTasks, useDeletedTasks, useDeleteTask, useRestoreTask } = await import('./tasks.js');

function pages(rows, { cap = 2, failAt = Infinity, missingColumn = false } = {}) {
  const calls = [];
  const query = (source) => {
    const state = { source, active: false, order: [] };
    return {
      select() { return this; }, or() { return this; },
      is(column, value) { assert.equal(column, 'deleted_at'); assert.equal(value, null); state.active = true; return this; },
      order(column) { state.order.push(column); return this; },
      async range(start, end) {
        calls.push({ ...state, start });
        if (state.active && missingColumn) return { error: { code: '42703', message: 'column tasks.deleted_at does not exist' } };
        if (start >= failAt) return { error: { code: '42501', message: 'Access changed' } };
        return { data: rows.filter(row => !state.active || !row.deleted_at).slice(start, Math.min(end + 1, start + cap)) };
      },
    };
  };
  globalThis.taskTrashDb = { from: query, rpc: query };
  return calls;
}

test('active task reads exclude deleted work on every API page', async () => {
  const rows = Array.from({ length: 8 }, (_, id) => ({ id, deleted_at: id % 2 ? null : '2026-09-28T10:00:00Z' }));
  const calls = pages(rows);
  assert.deepEqual(await useTasks().queryFn(), rows.filter(row => !row.deleted_at));
  assert.ok(calls.length > 2);
  assert.ok(calls.every(call => call.active && call.order.at(-1) === 'id'));
});

test('older schemas retain readable boards while real read refusals never fall back', async () => {
  const rows = [{ id: 'legacy' }];
  const calls = pages(rows, { missingColumn: true });
  assert.deepEqual(await useTasks().queryFn(), rows);
  assert.ok(calls.some(call => !call.active));
  const denied = pages(rows, { failAt: 0 });
  await assert.rejects(useTasks().queryFn(), error => error.code === '42501');
  assert.equal(denied.length, 1);
});

test('deleted tasks page all restorable roots in stable deletion order and reject partial results', async () => {
  const rows = Array.from({ length: 9 }, (_, id) => ({ id, can_restore: true, deleted_at: '2026-09-28T10:00:00Z' }));
  const calls = pages(rows);
  assert.deepEqual(await useDeletedTasks().queryFn(), rows);
  assert.ok(calls.every(call => call.source === 'list_deleted_tasks' && call.order.join() === 'deleted_at,id'));
  assert.equal(useDeletedTasks({ enabled: false }).enabled, false);
  pages(rows, { failAt: 4 });
  await assert.rejects(useDeletedTasks().queryFn(), error => error.code === '42501');
});

test('delete and restore use atomic RPCs, and refresh all live task surfaces', async () => {
  const calls = [];
  globalThis.taskTrashDb = {
    from() { assert.fail('Trash operations must never issue permanent deletes or separate child writes'); },
    async rpc(name, args) { calls.push({ name, args }); return { data: args._task_id }; },
  };
  for (const [hook, name] of [[useDeleteTask, 'soft_delete_task'], [useRestoreTask, 'restore_task']]) {
    assert.equal(await hook().mutationFn('task-1'), 'task-1');
    assert.deepEqual(calls.at(-1), { name, args: { _task_id: 'task-1' } });
    globalThis.taskTrashInvalidations = [];
    await hook().onSuccess();
    for (const key of ['tasks', 'deleted-tasks', 'section-counts', 'notifications', 'task-comments', 'task-checklist', 'task-attachments']) {
      assert.ok(globalThis.taskTrashInvalidations.some(prefix => prefix[0] === key), key);
    }
  }
});

test('missing recovery migrations never cause a permanent delete and permission errors remain visible', async () => {
  globalThis.taskTrashDb = { from() { assert.fail('No hard-delete fallback'); }, async rpc() { return { error: { code: 'PGRST202' } }; } };
  await assert.rejects(useDeleteTask().mutationFn('task-1'), /recovery database update/);
  await assert.rejects(useRestoreTask().mutationFn('task-1'), /recovery database update/);
  const error = { code: '42501', message: 'Outside your scope' };
  globalThis.taskTrashDb.rpc = async () => ({ error });
  await assert.rejects(useRestoreTask().mutationFn('task-1'), failure => failure === error);
});

test('delete and restore replace initial reads so older snapshots cannot hide their result', async () => {
  const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  for (const [hook, deleted] of [[useDeleteTask, true], [useRestoreTask, false]]) {
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
    globalThis.taskTrashClient = client;
    const releases = { tasks: [], 'deleted-tasks': [] };
    const unsubscribes = Object.keys(releases).map(key => new QueryObserver(client, {
      queryKey: [key], staleTime: Infinity,
      queryFn: () => new Promise(resolve => releases[key].push(resolve)),
    }).subscribe(() => {}));
    try {
      assert.equal(client.getQueryData(['tasks']), undefined);
      const refreshed = hook().onSuccess();
      await settle();
      for (const key of Object.keys(releases)) {
        assert.equal(releases[key].length, 2, `${key} must replace its initial read`);
        const current = (key === 'deleted-tasks') === deleted ? [{ id: 'task-1' }] : [];
        releases[key][1](current);
      }
      await refreshed;
      for (const key of Object.keys(releases)) {
        const old = (key === 'deleted-tasks') === deleted ? [] : [{ id: 'task-1' }];
        releases[key][0](old);
      }
      await settle();
      assert.deepEqual(client.getQueryData(['tasks']), deleted ? [] : [{ id: 'task-1' }]);
      assert.deepEqual(client.getQueryData(['deleted-tasks']), deleted ? [{ id: 'task-1' }] : []);
    } finally {
      unsubscribes.forEach(unsubscribe => unsubscribe());
      client.clear();
      delete globalThis.taskTrashClient;
    }
  }
});
