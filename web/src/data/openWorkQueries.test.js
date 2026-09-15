import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Exercise the real operational queries and pagination without credentials or a browser.
const stubs = {
  '@tanstack/react-query': 'export const useQuery = x => x; export const useMutation = x => x; export const useQueryClient = () => ({});',
  supabaseClient: 'export const supabase = { from: (...args) => globalThis.openWorkDb.from(...args), rpc: (...args) => globalThis.openWorkDb.rpc(...args) };',
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

const { useLeaves, useLeavesForPeriod } = await import('./leaves.js');
const { useExpenses, useExpensesForPeriod } = await import('./expenses.js');
const { useTickets } = await import('./tickets.js');
const { istToday } = await import('../lib/dates.js');

function fixtureDb(rows) {
  const reads = [];
  globalThis.openWorkDb = {
    rpc(name, args) {
      assert.equal(name, 'list_tickets');
      assert.match(args._since, /^\d{4}-\d{2}-\d{2}$/);
      // The RPC applies this same window before PostgREST ranges its result. Its SQL and
      // management flags are covered separately; keep the oldest open rows in this regression.
      return globalThis.openWorkDb.from('tickets').or(`status.in.(Open,"In Progress","On Hold"),created_at.gte.${args._since}`);
    },
    from(table) {
      const predicates = [], order = [];
      let offset = 0, end = Infinity;
      const query = {
        select() { return query; },
        gte(column, value) { predicates.push(row => row[column] >= value); return query; },
        lte(column, value) { predicates.push(row => row[column] <= value); return query; },
        or(expression) {
          const match = expression.match(/^status\.in\.\(([^)]+)\),(\w+)\.gte\.(.+)$/);
          assert.ok(match, `Unsupported fixture predicate: ${expression}`);
          const statuses = match[1].split(',').map(status => status.replaceAll('"', ''));
          predicates.push(row => statuses.includes(row.status) || row[match[2]] >= match[3]);
          return query;
        },
        order(column, options = {}) { order.push([column, options.ascending !== false]); return query; },
        range(from, to) { offset = from; end = to; return query; },
        then(resolve, reject) {
          reads.push({ table, offset, order });
          const data = rows.filter(row => predicates.every(predicate => predicate(row))).sort((a, b) => {
            for (const [column, ascending] of order) {
              if (a[column] !== b[column]) return (a[column] < b[column] ? -1 : 1) * (ascending ? 1 : -1);
            }
            return 0;
          }).slice(offset, Math.min(end + 1, offset + 37));
          return Promise.resolve({ data }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  return reads;
}

for (const [table, hook, dateColumn, openStatuses, settledStatuses] of [
  ['leaves', useLeaves, 'start_date', ['Pending', 'On Hold'], ['Approved', 'Rejected', 'Cancelled']],
  ['expenses', useExpenses, 'expense_date', ['Pending', 'Approved'], ['Paid', 'Rejected']],
  ['tickets', useTickets, 'created_at', ['Open', 'In Progress', 'On Hold'], ['Resolved']],
]) {
  test(`${table}: old unfinished work stays visible across API pages; only old settled history ages out`, async () => {
    const oldOpen = Array.from({ length: 151 }, (_, i) => ({
      id: `open-${String(i).padStart(4, '0')}`, status: openStatuses[i % openStatuses.length],
      created_at: '2000-01-01T00:00:00Z', [dateColumn]: '2000-01-01',
    }));
    const oldSettled = settledStatuses.map(status => ({ id: `old-${status}`, status,
      created_at: '2000-01-01T00:00:00Z', [dateColumn]: '2000-01-01' }));
    const recentSettled = settledStatuses.map(status => ({ id: `recent-${status}`, status,
      created_at: `${istToday()}T00:00:00Z`, [dateColumn]: istToday() }));
    const reads = fixtureDb([...oldOpen, ...oldSettled, ...recentSettled]);
    const query = hook();
    assert.deepEqual(query.queryKey, [table], 'existing mutation/realtime invalidation still reaches this query');
    const data = await query.queryFn();
    assert.deepEqual(new Set(data.map(row => row.id)), new Set([...oldOpen, ...recentSettled].map(row => row.id)));
    assert.ok(reads.length > 4, 'the oldest open records must survive more than one server page');
    assert.ok(reads.every(read => read.table === table && read.order.at(-1)?.[0] === 'id'));
  });
}

test('period reports retain their selected date boundaries instead of pulling in unrelated open work', async () => {
  const rows = [
    { id: 'outside', status: 'Pending', start_date: '2000-01-01', end_date: '2000-01-02', expense_date: '2000-01-01' },
    { id: 'inside', status: 'Approved', start_date: '2026-08-02', end_date: '2026-08-03', expense_date: '2026-08-02' },
  ];
  for (const hook of [useLeavesForPeriod, useExpensesForPeriod]) {
    fixtureDb(rows);
    const data = await hook('2026-08-01', '2026-08-31').queryFn();
    assert.deepEqual(data.map(row => row.id), ['inside']);
  }
});
