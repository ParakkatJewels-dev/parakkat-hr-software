import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildThread, threadingAvailable } from '../lib/commentThread.js';

// Exercise the real data hook and schema fallback, replacing only framework/database boundaries.
const stubs = {
  '@tanstack/react-query': 'export const useQuery = options => options; export const useMutation = options => options; export const useQueryClient = () => ({ invalidateQueries() {} });',
  supabaseClient: 'export const supabase = { from: table => globalThis.commentTestDb.from(table) };',
  AuthContext: 'export const useAuth = () => ({ employee: { id: "employee-1" }, user: { id: "user-1" } });',
};
registerHooks({
  resolve(specifier, context, next) {
    const key = specifier in stubs ? specifier : specifier.split('/').at(-1).replace(/\.(jsx?|tsx?)$/, '');
    if (stubs[key]) return { url: `data:text/javascript,${encodeURIComponent(stubs[key])}`, shortCircuit: true };
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const url = new URL(`${specifier}.js`, context.parentURL);
      if (existsSync(fileURLToPath(url))) return next(url.href, context);
    }
    return next(specifier, context);
  },
});
const { useTaskComments } = await import('./taskComments.js');

const rows = Array.from({ length: 1250 }, (_, i) => ({
  id: `comment-${String(i).padStart(4, '0')}`, task_id: 'task-1', body: `Comment ${i}`,
  parent_id: i % 4 ? `comment-${String(i - i % 4).padStart(4, '0')}` : null,
  created_at: '2026-01-01T00:00:00Z',
}));
rows.push({ id: 'comment-1250', task_id: 'task-1', body: 'Orphan reply',
  parent_id: 'deleted-parent', created_at: '2026-01-02T00:00:00Z' });
rows.push({ id: 'other-task', task_id: 'task-2', body: 'Outside this task', parent_id: null,
  created_at: '2026-01-01T00:00:00Z' });

function installDb({ legacy = false, failAfter = Infinity, cap = 97 } = {}) {
  const calls = [];
  globalThis.commentTestDb = {
    from(table) {
      assert.equal(table, 'task_comments');
      let fields = '', taskId, from = 0, to = Infinity;
      const orders = [];
      const query = {
        select(value) { fields = value; return query; },
        eq(field, value) { assert.equal(field, 'task_id'); taskId = value; return query; },
        order(field, options = {}) { orders.push([field, options.ascending !== false]); return query; },
        range(start, end) { from = start; to = end; return query; },
        then(resolve, reject) {
          calls.push({ fields, taskId, from, to, orders });
          if (legacy && fields.includes('parent_id')) return Promise.resolve({ error: { code: '42703', message: 'column parent_id does not exist' } }).then(resolve, reject);
          if (from >= failAfter) return Promise.resolve({ error: new Error('Task access changed') }).then(resolve, reject);
          const all = rows.filter(row => row.task_id === taskId).sort((a, b) => {
            for (const [key, ascending] of orders) {
              if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * (ascending ? 1 : -1);
            }
            return 0;
          });
          const data = all.slice(from, Math.min(to + 1, from + cap)).map(row => {
            if (fields.includes('parent_id')) return { ...row };
            const { parent_id: _parent, ...flat } = row;
            return flat;
          });
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  return calls;
}

test('a task loads beyond 500 comments under the API row cap without losing reply groups or orphan replies', async () => {
  const calls = installDb();
  const comments = await useTaskComments('task-1').queryFn();
  assert.equal(comments.length, 1251);
  assert.equal(new Set(comments.map(comment => comment.id)).size, 1251);
  assert.equal(comments.at(-1).body, 'Orphan reply');
  assert.ok(calls.length > 12);
  assert.ok(calls.every(call => call.taskId === 'task-1'));
  assert.ok(calls.every(call => JSON.stringify(call.orders) === JSON.stringify([['created_at', true], ['id', true]])));
  const thread = buildThread(comments);
  assert.equal(thread.reduce((total, root) => total + 1 + root.replies.length, 0), comments.length);
  assert.equal(thread.find(root => root.id === 'comment-0096').replies.length, 3, 'reply groups spanning query boundaries stay together');
  assert.ok(thread.some(root => root.id === 'comment-1250'), 'a deleted parent cannot hide its surviving reply');
  assert.equal(threadingAvailable(comments), true);
});

test('pre-threading schemas still load the complete task beyond 500 flat comments', async () => {
  const calls = installDb({ legacy: true });
  const comments = await useTaskComments('task-1').queryFn();
  assert.equal(comments.length, 1251);
  assert.equal(comments.at(-1).id, 'comment-1250');
  assert.equal(calls.filter(call => call.fields.includes('parent_id')).length, 1);
  assert.ok(calls.filter(call => !call.fields.includes('parent_id')).length > 12);
  assert.equal(threadingAvailable(comments), false);
  assert.equal(buildThread(comments).length, 1251);
});

test('later-page access errors reject the whole task read for both current and legacy schemas', async () => {
  for (const legacy of [false, true]) {
    const calls = installDb({ legacy, failAfter: 194 });
    await assert.rejects(useTaskComments('task-1').queryFn(), /Task access changed/);
    if (!legacy) assert.ok(calls.every(call => call.fields.includes('parent_id')), 'permission errors must not trigger a schema fallback');
  }
});

test('closed tasks and missing task IDs leave the comment query disabled', () => {
  assert.equal(useTaskComments('task-1', { enabled: false }).enabled, false);
  assert.equal(useTaskComments(null).enabled, false);
});
