import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { QueryClient } from '@tanstack/query-core';
import { NAVIGATION_COUNT_KEYS } from '../lib/navigationCounts.js';

const stubs = {
  '@tanstack/react-query': 'export const useQuery = options => options;',
  AuthContext: 'export const useAuth = () => ({ user: globalThis.sectionCountUser });',
  supabaseClient: 'export const supabase = { rpc: (...args) => globalThis.sectionCountRpc(...args) };',
};
registerHooks({ resolve(specifier, context, next) {
  const key = specifier in stubs ? specifier : specifier.split('/').at(-1).replace(/\.jsx?$/, '');
  if (stubs[key]) return { url: `data:text/javascript,${encodeURIComponent(stubs[key])}`, shortCircuit: true };
  return next(specifier, context);
} });
const { useSectionCounts, validateSectionCounts } = await import('./sectionCounts.js');
const counts = { ...Object.fromEntries(NAVIGATION_COUNT_KEYS.map(key => [key, 0])),
  tasks: 3, leave: 2, expense: 1, attendance: 4, helpdesk: 125, task_requests: 2, task_routine: 6,
  performance_mine: 3, performance_team: 8, payroll: 1, onboarding: 2, recruitment: 4,
  exits: 1, notifications: 150, attendance_mapping: 5 };

test('summary reads one aggregate RPC, forwards cancellation, and sends no user or scope identity', async () => {
  globalThis.sectionCountUser = { id: 'person-1' };
  const signal = new AbortController().signal;
  globalThis.sectionCountRpc = (name, args) => {
    assert.equal(name, 'get_navigation_counts');
    assert.deepEqual(args, { _self_only: true });
    return { abortSignal(received) { assert.equal(received, signal); return Promise.resolve({ data: counts }); } };
  };
  assert.deepEqual(await useSectionCounts({ selfOnly: true }).queryFn({ signal }), counts);
});

test('personal and oversight counts are isolated between users and disabled when signed out', () => {
  globalThis.sectionCountUser = { id: 'person-1' };
  const oversight = useSectionCounts();
  const personal = useSectionCounts({ selfOnly: true });
  assert.notDeepEqual(oversight.queryKey, personal.queryKey);
  globalThis.sectionCountUser = { id: 'person-2' };
  assert.notDeepEqual(oversight.queryKey, useSectionCounts().queryKey);
  assert.equal(useSectionCounts({ enabled: false }).enabled, false);
  globalThis.sectionCountUser = null;
  assert.equal(useSectionCounts().enabled, false);
  assert.equal(oversight.refetchIntervalInBackground, false);
});

test('missing, partial and invalid summary responses cannot become zero badges', async () => {
  for (const invalid of [null, [], {}, { ...counts, helpdesk: null }, { ...counts, tasks: -1 },
    { ...counts, leave: '2' }, { ...counts, expense: Infinity }, { ...counts, attendance: 1.5 }]) {
    assert.throws(() => validateSectionCounts(invalid), /could not be loaded/);
  }
  assert.deepEqual(validateSectionCounts(Object.fromEntries(Object.keys(counts).map(key => [key, 0]))),
    Object.fromEntries(NAVIGATION_COUNT_KEYS.map(key => [key, 0])));
  for (const key of NAVIGATION_COUNT_KEYS) {
    const partial = { ...counts }; delete partial[key];
    assert.throws(() => validateSectionCounts(partial), /could not be loaded/);
  }
  globalThis.sectionCountRpc = async () => ({ error: new Error('Permission changed') });
  await assert.rejects(useSectionCounts().queryFn(), /Permission changed/);
});

test('simultaneous consumers share a cached summary and failures preserve the last known counts', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  globalThis.sectionCountUser = { id: 'person-1' };
  let reads = 0;
  globalThis.sectionCountRpc = () => {
    reads++;
    return { abortSignal: async () => ({ data: counts }) };
  };
  try {
    await Promise.all([client.fetchQuery(useSectionCounts()), client.fetchQuery(useSectionCounts())]);
    await client.fetchQuery(useSectionCounts());
    assert.equal(reads, 1);
    await client.invalidateQueries({ queryKey: ['section-counts'], refetchType: 'none' });
    globalThis.sectionCountRpc = () => ({ abortSignal: async () => ({ error: new Error('Network unavailable') }) });
    await assert.rejects(client.fetchQuery(useSectionCounts()), /Network unavailable/);
    assert.deepEqual(client.getQueryData(useSectionCounts().queryKey), counts);
  } finally { client.clear(); }
});

test('a persisted five-queue cache cannot masquerade as the complete navigation summary', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  globalThis.sectionCountUser = { id: 'person-1' };
  const legacyKey = ['section-counts', 'person-1', false];
  const legacyCounts = { tasks: 4, leave: 2, expense: 1, attendance: 3, helpdesk: 0 };
  client.setQueryData(legacyKey, legacyCounts);
  const options = useSectionCounts();
  try {
    assert.deepEqual(options.queryKey, [...legacyKey, 'navigation-v2']);
    assert.equal(client.getQueryData(options.queryKey), undefined);
    globalThis.sectionCountRpc = () => ({ abortSignal: async () => ({ error: new Error('New summary not deployed') }) });
    await assert.rejects(client.fetchQuery(options), /New summary not deployed/);
    assert.equal(client.getQueryData(options.queryKey), undefined);
    assert.deepEqual(client.getQueryData(legacyKey), legacyCounts);
    globalThis.sectionCountRpc = () => ({ abortSignal: async () => ({ data: counts }) });
    assert.deepEqual(await client.fetchQuery(options), counts);
    assert.deepEqual(client.getQueryData(options.queryKey), counts);
  } finally { client.clear(); }
});
