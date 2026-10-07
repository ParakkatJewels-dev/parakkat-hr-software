import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient } from '@tanstack/react-query';
import { getPayrollSessionStateEntry, hasPayrollSessionChanges, hasAnyPayrollSessionChanges } from './usePayrollSessionState.js';

test('same-client remounts recover state and keep the setter stable for an equivalent serialized key', () => {
  const client = new QueryClient();
  const first = getPayrollSessionStateEntry(client, ['payroll', 'entity-a', '2026-10'], {});
  const draft = { employee1: { incentive: '1500' } };
  first.set(draft);
  const remounted = getPayrollSessionStateEntry(client, ['payroll', 'entity-a', '2026-10'], { reset: true });
  assert.equal(remounted, first);
  assert.equal(remounted.set, first.set);
  assert.equal(remounted.getSnapshot(), draft);
});

test('functional updates commit synchronously, including while a route is unmounted', () => {
  const client = new QueryClient();
  const entry = getPayrollSessionStateEntry(client, 'counter', 0);
  entry.set(current => current + 1);
  entry.set(current => current + 1);
  assert.equal(entry.getSnapshot(), 2);
  entry.set(12);
  assert.equal(getPayrollSessionStateEntry(client, 'counter', 0).getSnapshot(), 12);
  entry.set(() => undefined);
  assert.equal(getPayrollSessionStateEntry(client, 'counter', 99).getSnapshot(), undefined);
});

test('new QueryClients and different payroll contexts remain isolated', () => {
  const firstClient = new QueryClient(); const secondClient = new QueryClient();
  getPayrollSessionStateEntry(firstClient, ['drafts', 'a', '2026-10'], {}).set({ salary: 'private' });
  assert.deepEqual(getPayrollSessionStateEntry(secondClient, ['drafts', 'a', '2026-10'], {}).getSnapshot(), {});
  assert.deepEqual(getPayrollSessionStateEntry(firstClient, ['drafts', 'b', '2026-10'], {}).getSnapshot(), {});
  assert.deepEqual(getPayrollSessionStateEntry(firstClient, ['drafts', 'a', '2026-11'], {}).getSnapshot(), {});
  assert.notEqual(getPayrollSessionStateEntry(firstClient, ['drafts'], {}).set,
    getPayrollSessionStateEntry(secondClient, ['drafts'], {}).set);
});

test('lazy initializers run once per session key and never replace retained false or empty values', () => {
  const client = new QueryClient(); let calls = 0;
  const initialize = () => { calls += 1; return false; };
  const first = getPayrollSessionStateEntry(client, { kind: 'policy', entity: 'a' }, initialize);
  assert.equal(first.getSnapshot(), false);
  assert.equal(getPayrollSessionStateEntry(client, { kind: 'policy', entity: 'a' }, initialize).getSnapshot(), false);
  first.set('');
  assert.equal(getPayrollSessionStateEntry(client, { kind: 'policy', entity: 'a' }, initialize).getSnapshot(), '');
  assert.equal(calls, 1);
});

test('subscribers see committed changes, can unsubscribe, and identical values do not notify', () => {
  const entry = getPayrollSessionStateEntry(new QueryClient(), 'drafts', null);
  const seen = [];
  const unsubscribe = entry.subscribe(() => seen.push(entry.getSnapshot()));
  entry.set('one'); entry.set('one'); entry.set('two');
  unsubscribe(); entry.set('three');
  assert.deepEqual(seen, ['one', 'two']);
  assert.equal(entry.getSnapshot(), 'three');
});

test('retained payroll memory never enters the query cache or browser persistence', () => {
  const client = new QueryClient();
  const entry = getPayrollSessionStateEntry(client, ['drafts'], { incentive: '250' });
  assert.deepEqual(client.getQueryCache().getAll(), []);
  client.clear();
  assert.equal(getPayrollSessionStateEntry(client, ['drafts'], {}).getSnapshot(), entry.getSnapshot());
  entry.set({});
  assert.deepEqual(entry.getSnapshot(), {});
  assert.deepEqual(client.getQueryCache().getAll(), []);
});

test('invalid client/key and throwing initializer cannot create misleading retained state', () => {
  assert.throws(() => getPayrollSessionStateEntry(null, ['a'], 0), /QueryClient/);
  const client = new QueryClient();
  assert.throws(() => getPayrollSessionStateEntry(client, undefined, 0), /serializable key/);
  assert.throws(() => getPayrollSessionStateEntry(client, 'a', () => { throw new Error('initialization failed'); }), /initialization failed/);
  assert.equal(getPayrollSessionStateEntry(client, 'a', 3).getSnapshot(), 3);
  const entry = getPayrollSessionStateEntry(client, 'b', 1);
  assert.throws(() => entry.set(() => { throw new Error('update failed'); }), /update failed/);
  assert.equal(entry.getSnapshot(), 1);
});

test('change lookup does not create entries or shadow editor lazy initializers', () => {
  const client = new QueryClient();
  assert.equal(hasPayrollSessionChanges(client, 'a', '2026-10'), false);
  assert.equal(hasPayrollSessionChanges(client, 'a', '2026-10'), false);
  let initialized = 0;
  const policy = getPayrollSessionStateEntry(client, ['policy', 'a'], () => {
    initialized += 1; return { dirty: false, draft: { hours_per_day: '8' } };
  });
  assert.equal(initialized, 1);
  assert.equal(policy.getSnapshot().draft.hours_per_day, '8');
  const inputs = getPayrollSessionStateEntry(client, ['inputs', 'a', '2026-10'], () => ({ employee1: { draft: {} } }));
  assert.equal(hasPayrollSessionChanges(client, 'a', '2026-10'), true);
  inputs.set({});
  assert.equal(hasPayrollSessionChanges(client, 'a', '2026-10'), false);
});

test('change lookup scopes input drafts and previews to company/month and policy to company', () => {
  const client = new QueryClient();
  const inputs = getPayrollSessionStateEntry(client, ['inputs', 'a', '2026-10'], {});
  const preview = getPayrollSessionStateEntry(client, ['preview', 'a', '2026-10'], null);
  const policy = getPayrollSessionStateEntry(client, ['policy', 'a'], null);
  assert.equal(hasPayrollSessionChanges(client, 'a', '2026-10'), false);
  inputs.set({ employee1: { draft: { incentive: '100' } } });
  assert.equal(hasPayrollSessionChanges(client, 'a', '2026-10'), true);
  assert.equal(hasPayrollSessionChanges(client, 'a', '2026-11'), false);
  assert.equal(hasPayrollSessionChanges(client, 'b', '2026-10'), false);
  assert.equal(hasPayrollSessionChanges(new QueryClient(), 'a', '2026-10'), false);
  inputs.set({}); preview.set({ rows: [] });
  assert.equal(hasPayrollSessionChanges(client, 'a', '2026-10'), true);
  preview.set(null); policy.set({ dirty: true, draft: {} });
  assert.equal(hasPayrollSessionChanges(client, 'a', '2026-11'), true);
  assert.equal(hasPayrollSessionChanges(client, 'b', '2026-10'), false);
  policy.set({ dirty: false, draft: {} });
  assert.equal(hasPayrollSessionChanges(client, 'a', '2026-10'), false);
});

test('retained salary edits block only their company until saved or discarded', () => {
  const client = new QueryClient();
  const salary = getPayrollSessionStateEntry(client, ['salary-setup'], null);
  const form = { employee_id: 'worker', effective_from: '2026-09-01', basic: '10000', gross_components: [] };
  salary.set({ employeeId: 'worker', entityId: 'a', form, initialForm: { ...form } });
  assert.equal(hasPayrollSessionChanges(client, 'a', '2026-10'), false, 'opening a salary editor does not block payroll');
  salary.set(value => ({ ...value, form: { ...value.form, basic: '12000' } }));
  assert.equal(hasPayrollSessionChanges(client, 'a', '2026-10'), true);
  assert.equal(hasPayrollSessionChanges(client, 'a', '2026-11'), true, 'salary affects multiple months');
  assert.equal(hasPayrollSessionChanges(client, 'b', '2026-10'), false);
  assert.equal(hasPayrollSessionChanges(new QueryClient(), 'a', '2026-10'), false);
  salary.set(null);
  assert.equal(hasPayrollSessionChanges(client, 'a', '2026-10'), false);
});


test('unload guard finds retained edits outside the selected payroll month and ignores clean navigation state', () => {
  const client = new QueryClient();
  getPayrollSessionStateEntry(client, ['context'], { entityId: 'b', period: '2026-10' });
  getPayrollSessionStateEntry(client, ['step', 'b', '2026-10'], 'review');
  assert.equal(hasAnyPayrollSessionChanges(client), false);
  for (const [key, dirty, clean] of [
    [['inputs', 'a', '2026-08'], { employee: { draft: { incentive: '100' } } }, {}],
    [['preview', 'a', '2026-08'], { rows: [] }, null],
    [['transactions', 'a', '2026-08'], { dirty: true }, { dirty: false }],
    [['policy', 'a'], { dirty: true }, { dirty: false }],
    [['salary-setup'], { entityId: 'a', form: { basic: '100' }, initialForm: { basic: '90' } }, null],
  ]) {
    const entry = getPayrollSessionStateEntry(client, key, clean);
    entry.set(dirty);
    assert.equal(hasAnyPayrollSessionChanges(client), true);
    entry.set(clean);
    assert.equal(hasAnyPayrollSessionChanges(client), false);
  }
  assert.equal(hasAnyPayrollSessionChanges(new QueryClient()), false);
});
