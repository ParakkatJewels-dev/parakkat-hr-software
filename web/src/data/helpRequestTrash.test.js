import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const stubs = {
  '@tanstack/react-query': 'export const useQuery = value => value; export const useMutation = value => value; export const useQueryClient = () => ({});',
  supabaseClient: 'export const supabase = { from: (...args) => globalThis.helpRequestTrashDb.from(...args) };',
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
const { useHelpRequests } = await import('./helpRequests.js');

function fixture(rows, error) {
  const reads = [];
  globalThis.helpRequestTrashDb = {
    from(table) {
      assert.equal(table, 'help_requests');
      let fields;
      const order = [];
      return {
        select(value) { fields = value; return this; },
        or() { return this; },
        order(column) { order.push(column); return this; },
        async range(start, end) {
          reads.push({ fields, order, start });
          if (fields.includes('deleted_at') && error) return { error };
          return { data: rows.slice(start, Math.min(end + 1, start + 2)) };
        },
      };
    },
  };
  return reads;
}

test('request reads retain deleted-task state on every API page for both departments', async () => {
  const rows = Array.from({ length: 8 }, (_, id) => ({ id, task: { id: `task-${id}`, deleted_at: id % 2 ? null : '2026-09-28T09:00:00Z' } }));
  const reads = fixture(rows);
  assert.deepEqual(await useHelpRequests().queryFn(), rows);
  assert.ok(reads.length > 2);
  assert.ok(reads.every(read => read.fields.includes('due_date, deleted_at)') && read.order.at(-1) === 'id'));
});

test('only a missing task recovery column triggers the legacy request read', async () => {
  for (const error of [
    { code: '42703', message: 'column tasks_1.deleted_at does not exist' },
    { code: 'PGRST204', message: "Could not find the 'deleted_at' column in the schema cache" },
  ]) {
    const rows = [{ id: 'legacy', task: { id: 'task-1', status: 'In Progress' } }];
    const reads = fixture(rows, error);
    assert.deepEqual(await useHelpRequests().queryFn(), rows);
    assert.ok(reads[0].fields.includes('deleted_at'));
    assert.ok(reads.slice(1).every(read => !read.fields.includes('deleted_at')));
  }
});

test('permission, network and unrelated schema failures remain visible without a legacy retry', async () => {
  for (const error of [
    { code: '42501', message: 'Access refused' },
    { message: 'Failed to fetch' },
    { code: '42703', message: 'column help_requests.priority does not exist' },
  ]) {
    const reads = fixture([], error);
    await assert.rejects(useHelpRequests().queryFn(), failure => failure === error);
    assert.equal(reads.length, 1);
  }
});
