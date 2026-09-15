import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Keep the actual query factories and collection loader; replace only their framework/database boundary.
const stubs = {
  '@tanstack/react-query': 'export const useQuery = x => x; export const useMutation = x => x; export const useQueryClient = () => ({});',
  supabaseClient: 'export const supabase = { from: (...args) => globalThis.assetPaginationDb.from(...args) };',
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
const { useAssetHistory, useEmployeeAssets } = await import('./assets.js');
const { usePayComponents } = await import('./payroll.js');

function cappedDb(rows, failAfterFirstPage = false) {
  const calls = [];
  globalThis.assetPaginationDb = {
    from(table) {
      const conditions = [], order = [];
      let from = 0, to = Infinity;
      const q = {
        select() { return q; },
        eq(key, value) { conditions.push(row => row[key] === value); return q; },
        order(key, options = {}) { order.push([key, options.ascending !== false]); return q; },
        range(start, end) { from = start; to = end; return q; },
        then(resolve, reject) {
          calls.push({ table, from, order });
          if (failAfterFirstPage && from > 0) return Promise.resolve({ error: new Error('Read denied') }).then(resolve, reject);
          const data = rows.filter(row => conditions.every(check => check(row))).sort((a, b) => {
            for (const [key, ascending] of order) {
              if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * (ascending ? 1 : -1);
            }
            return 0;
          }).slice(from, Math.min(to + 1, from + 37));
          return Promise.resolve({ data }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  return calls;
}

const records = Array.from({ length: 251 }, (_, i) => ({ id: `row-${String(i).padStart(4, '0')}`,
  asset_id: 'asset-1', employee_id: 'self', assigned_at: '2026-09-01', name: 'Same name', code: 'AL', display_order: 1 }));

test('custody, assigned assets and pay components fetch every row beyond the API cap with stable ordering', async () => {
  for (const [table, hook] of [
    ['asset_assignments', () => useAssetHistory('asset-1')],
    ['assets', () => useEmployeeAssets('self')],
    ['pay_components', usePayComponents],
  ]) {
    const unrelated = { ...records[0], id: 'unrelated', asset_id: 'other-asset', employee_id: 'other-employee' };
    const input = table === 'pay_components' ? records : [...records, unrelated];
    const calls = cappedDb(input);
    const data = await hook().queryFn();
    assert.deepEqual(data, records, table);
    assert.ok(calls.length > 7, `${table} must request additional pages`);
    assert.ok(calls.every(call => call.table === table && call.order.at(-1)?.[0] === 'id'));
  }
  assert.equal(useAssetHistory(null).enabled, false);
  assert.equal(useEmployeeAssets(null).enabled, false);
});

test('a later-page failure does not return an incomplete history or payroll component list', async () => {
  for (const hook of [() => useAssetHistory('asset-1'), () => useEmployeeAssets('self'), usePayComponents]) {
    cappedDb(records, true);
    await assert.rejects(hook().queryFn(), /Read denied/);
  }
});
