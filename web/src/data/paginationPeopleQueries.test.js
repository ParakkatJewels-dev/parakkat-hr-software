import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const stubs = {
  '@tanstack/react-query': 'export const useQuery = value => value; export const useMutation = value => value; export const useQueryClient = () => ({});',
  react: 'export const useCallback = value => value;',
  supabaseClient: 'export const supabase = { from: (...args) => globalThis.peopleDb.from(...args), rpc: (...args) => globalThis.peopleDb.rpc(...args) };',
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
const admin = await import('./admin.js');
const team = await import('./team.js');

function fixture(rows, { failAfter } = {}) {
  const reads = [];
  const db = {
    reads,
    rpc(name, params) {
      assert.equal(name, 'assignable_employees');
      assert.deepEqual(params, { _department: 'team-1', _q: 'Ada' });
      return db.from('candidates');
    },
    from(table) {
      const order = [];
      const query = {
        select() { return query; },
        order(column) { order.push(column); return query; },
        range(from, to) {
          reads.push({ table, from, order });
          if (failAfter != null && from >= failAfter) return Promise.resolve({ error: new Error('Access revoked') });
          return Promise.resolve({ data: rows.slice(from, Math.min(to + 1, from + 97)) });
        },
      };
      return query;
    },
  };
  return db;
}

test('team employee picker reads every RPC page beyond both the former 50-person limit and server cap', async () => {
  const rows = Array.from({ length: 1205 }, (_, i) => ({ id: `employee-${i}`, full_name: `Ada ${i}` }));
  globalThis.peopleDb = fixture(rows);
  assert.deepEqual(await team.useAssignableEmployees('team-1', '  Ada  ').queryFn(), rows);
  assert.ok(globalThis.peopleDb.reads.length > 12);
  assert.ok(globalThis.peopleDb.reads.every(read => read.order.join(',') === 'full_name,id'));
});

test('team employee picker exposes a failed later page instead of returning a partial roster', async () => {
  globalThis.peopleDb = fixture(Array.from({ length: 1205 }, (_, i) => ({ id: i })), { failAfter: 500 });
  await assert.rejects(team.useAssignableEmployees('team-1', 'Ada').queryFn(), /Access revoked/);
});

test('role list and role editor read the full collection with permission metadata intact', async () => {
  const rows = Array.from({ length: 1205 }, (_, i) => ({ id: `role-${i}`, key: `custom_${i}`,
    role_permissions: [{ permission: { key: 'employee.read' } }] }));
  for (const hook of [admin.useRoles, admin.useRolesWithPermissions]) {
    globalThis.peopleDb = fixture(rows);
    const result = await hook().queryFn();
    assert.equal(result.length, 1205);
    assert.equal(result.at(-1).id, 'role-1204');
    assert.deepEqual(result.at(-1).permissionKeys, ['employee.read']);
    assert.ok(globalThis.peopleDb.reads.every(read => read.order.join(',') === 'key,id'));
  }
});
