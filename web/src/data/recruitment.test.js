import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { QueryClient } from '@tanstack/query-core';

const stubs = {
  '@tanstack/react-query': 'export const useQuery = options => options; export const useMutation = options => options; export const useQueryClient = () => globalThis.recruitmentMutationAudit.client;',
  supabaseClient: 'export const supabase = { from: (...args) => globalThis.recruitmentMutationAudit.from(...args) };',
};
const loader = registerHooks({ resolve(specifier, context, next) {
  const key = specifier in stubs ? specifier : specifier.split('/').at(-1).replace(/\.js$/, '');
  if (stubs[key]) return { url: `data:text/javascript,${encodeURIComponent(stubs[key])}`, shortCircuit: true };
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(`${specifier}.js`, context.parentURL);
    if (existsSync(fileURLToPath(url))) return next(url.href, context);
  }
  return next(specifier, context);
} });
// The React Query hooks above return configuration, which the real mutation cache executes.
const { useSetCandidateStage: candidateStageOptions } = await import('./recruitment.js');
after(() => { loader.deregister(); delete globalThis.recruitmentMutationAudit; });

function harness(result) {
  const calls = [];
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  client.setQueryData(['candidates'], [{ id: 'candidate-one', stage: 'Offered' }]);
  client.setQueryData(['candidates', 'history'], []);
  client.setQueryData(['jobs'], [{ id: 'job-one' }]);
  globalThis.recruitmentMutationAudit = { client, from(table) {
    calls.push(['from', table]);
    return { update(payload) { calls.push(['update', payload]); return this; },
      eq(column, value) { calls.push(['eq', column, value]); return this; },
      async select(columns) {
        calls.push(['select', columns]);
        if (result instanceof Error) throw result;
        return result;
      } };
  } };
  const mutation = client.getMutationCache().build(client, candidateStageOptions());
  return { client, calls, mutation, execute: () => mutation.execute({ id: 'candidate-one', stage: 'Hired' }) };
}

for (const data of [[], null]) test(`candidate stage updates report zero-row RLS/deletion denial (${JSON.stringify(data)}) without success invalidation`, async () => {
  const h = harness({ data, error: null });
  try {
    await assert.rejects(h.execute(), /no longer available to update/);
    assert.equal(h.mutation.state.status, 'error');
    assert.equal(h.client.getQueryState(['candidates']).isInvalidated, false);
    assert.deepEqual(h.client.getQueryData(['candidates']), [{ id: 'candidate-one', stage: 'Offered' }]);
    assert.deepEqual(h.calls, [['from', 'candidates'], ['update', { stage: 'Hired' }],
      ['eq', 'id', 'candidate-one'], ['select', 'id']]);
  } finally { h.client.clear(); }
});

test('candidate server and transport errors preserve the refusal and do not report success', async () => {
  const denied = { code: '42501', message: 'Account access is disabled.' };
  for (const result of [{ data: null, error: denied }, new Error('Network unavailable')]) {
    const h = harness(result);
    try {
      const expected = result instanceof Error ? result : denied;
      await assert.rejects(h.execute(), error => error === expected);
      assert.equal(h.mutation.state.status, 'error');
      assert.equal(h.client.getQueryState(['candidates']).isInvalidated, false);
    } finally { h.client.clear(); }
  }
});

test('confirmed candidate stage updates invalidate pipeline and history only after success', async () => {
  const h = harness({ data: [{ id: 'candidate-one' }], error: null });
  try {
    assert.deepEqual(await h.execute(), { id: 'candidate-one' });
    assert.equal(h.mutation.state.status, 'success');
    assert.equal(h.client.getQueryState(['candidates']).isInvalidated, true);
    assert.equal(h.client.getQueryState(['candidates', 'history']).isInvalidated, true);
    assert.equal(h.client.getQueryState(['jobs']).isInvalidated, false);
  } finally { h.client.clear(); }
});
