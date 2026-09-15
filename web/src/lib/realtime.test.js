import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { QueryClient, QueryObserver } from '@tanstack/query-core';
import { messageDeliveryStatus } from './messageReceipts.js';

const stubs = {
  react: 'export const useEffect = effect => { globalThis.liveTest.cleanup = effect(); };',
  '@tanstack/react-query': 'export const useQueryClient = () => globalThis.liveTest.client;',
  supabaseClient: 'export const supabase = { channel: (...args) => globalThis.liveTest.channel(...args), realtime: { setAuth: () => {} }, removeChannel: () => globalThis.liveTest.removed() };',
  AuthContext: 'export const useAuth = () => ({ session: { access_token: "test-token" }, user: { id: "me" }, employee: { id: "employee-me" }, reloadAccess: () => { globalThis.liveTest.accessRefreshes++; } });',
};
registerHooks({
  resolve(specifier, context, next) {
    const key = specifier in stubs ? specifier : specifier.split('/').at(-1).replace(/\.jsx?$/, '');
    if (stubs[key]) return { url: `data:text/javascript,${encodeURIComponent(stubs[key])}`, shortCircuit: true };
    if (specifier === './messageReceipts') return next(new URL('./messageReceipts.js', context.parentURL).href, context);
    return next(specifier, context);
  },
});
const { useRealtimeSync } = await import('./realtime.js');
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function useLiveHarness(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const handlers = new Map(), invalidations = [], events = new Map();
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  const invalidate = client.invalidateQueries.bind(client);
  client.invalidateQueries = (...args) => { invalidations.push(args[0]); return invalidate(...args); };
  const oldDocument = globalThis.document;
  globalThis.document = { visibilityState: 'visible',
    addEventListener: (name, handler) => events.set(name, handler), removeEventListener: name => events.delete(name) };
  const state = { client, invalidations, handlers, events, accessRefreshes: 0,
    channel() { return {
      on(_kind, options, handler) { handlers.set(options.table, handler); return this; },
      subscribe(handler) { state.status = handler; return this; },
    }; },
    removed() { state.status('CLOSED'); },
  };
  globalThis.liveTest = state;
  useRealtimeSync();
  t.after(() => {
    state.cleanup();
    client.clear();
    globalThis.document = oldDocument;
    delete globalThis.liveTest;
  });
  return state;
}

test('recipient receipt UPDATEs change sender ticks before refetching the inbox', (t) => {
  const live = useLiveHarness(t);
  const stamp = '2026-09-15T10:00:00.123456Z';
  const message = { id: 'message-1', sender_id: 'sender', created_at: stamp };
  const room = { id: 'room-1', members: [{ employee_id: 'sender' }, { employee_id: 'recipient' }] };
  live.client.setQueryData(['conversations'], { conversations: [room], pending: false });
  live.client.setQueryData(['admin-conversations', 'recipient'], [room]);
  live.status('SUBSCRIBED');
  live.invalidations.length = 0;
  const receive = live.handlers.get('conversation_members');
  receive({ eventType: 'UPDATE', new: { conversation_id: room.id, employee_id: 'recipient',
    last_delivered_at: stamp, last_delivered_message_id: message.id } });
  assert.equal(messageDeliveryStatus(message, live.client.getQueryData(['conversations']).conversations[0]), 'delivered');
  receive({ eventType: 'UPDATE', new: { conversation_id: room.id, employee_id: 'recipient',
    last_read_at: stamp, last_read_message_id: message.id } });
  assert.equal(messageDeliveryStatus(message, live.client.getQueryData(['conversations']).conversations[0]), 'seen');
  assert.equal(messageDeliveryStatus(message, live.client.getQueryData(['admin-conversations', 'recipient'])[0]), 'seen');
  assert.equal(live.invalidations.length, 0, 'ticks update before any HTTP round trip');
  t.mock.timers.tick(100);
  assert.deepEqual(live.invalidations.map(value => value.queryKey), [['conversations'], ['admin-conversations'], ['message-delivery']]);
});

test('chat events refresh promptly and only the changed thread while bulk data stays batched', (t) => {
  const live = useLiveHarness(t);
  live.status('SUBSCRIBED');
  live.invalidations.length = 0;
  live.handlers.get('attendance')({ eventType: 'UPDATE', new: { id: 'attendance-1' } });
  for (let i = 0; i < 3; i++) live.handlers.get('messages')({ eventType: 'INSERT', new: { conversation_id: 'room-1' } });
  t.mock.timers.tick(100);
  assert.deepEqual(live.invalidations.map(value => value.queryKey), [['messages', 'room-1'], ['conversations'], ['admin-conversations'], ['message-delivery']]);
  assert.ok(live.invalidations.every(value => value.refetchType === 'active'));
  t.mock.timers.tick(900);
  assert.deepEqual(live.invalidations.at(-1).queryKey, ['attendance']);
});

test('a disconnected socket refreshes visible chat within ten seconds and stops on reconnect or unmount', (t) => {
  const live = useLiveHarness(t);
  t.mock.timers.tick(10_000);
  assert.equal(live.invalidations.length, 4, 'initial connection failure has a short chat fallback');
  globalThis.document.visibilityState = 'hidden';
  t.mock.timers.tick(10_000);
  assert.equal(live.invalidations.length, 4, 'background devices do not poll');
  live.status('SUBSCRIBED');
  live.invalidations.length = 0;
  globalThis.document.visibilityState = 'visible';
  t.mock.timers.tick(30_000);
  assert.equal(live.invalidations.length, 0, 'healthy realtime needs no extra poll');
  t.mock.method(console, 'warn', () => {});
  live.status('TIMED_OUT');
  t.mock.timers.tick(10_000);
  assert.equal(live.invalidations.length, 4);
  live.cleanup();
  live.invalidations.length = 0;
  live.status('CLOSED');
  t.mock.timers.tick(30_000);
  assert.equal(live.invalidations.length, 0, 'channel removal must not restart the fallback');
  assert.equal(live.events.size, 0);
});

test('task notifications refresh newly granted assignments without a task row event, once per batch', (t) => {
  const live = useLiveHarness(t);
  live.status('SUBSCRIBED');
  live.invalidations.length = 0;
  const notify = live.handlers.get('notifications');
  notify({ eventType: 'INSERT', new: { id: 'assignment-1', type: 'task', ref_id: 'task-1' } });
  notify({ eventType: 'INSERT', new: { id: 'assignment-2', type: 'task', ref_id: 'task-2' } });
  t.mock.timers.tick(999);
  assert.equal(live.invalidations.length, 0, 'task notifications share the existing one-second batch');
  t.mock.timers.tick(1);
  assert.deepEqual(live.invalidations, [
    { queryKey: ['notifications'], refetchType: 'active' },
    { queryKey: ['tasks'], refetchType: 'active' },
    { queryKey: ['notification-ref-statuses'], refetchType: 'active' },
  ]);
  live.invalidations.length = 0;
  notify({ eventType: 'INSERT', new: { id: 'chat-1', type: 'message', ref_id: 'room-1' } });
  t.mock.timers.tick(1_000);
  assert.deepEqual(live.invalidations, [{ queryKey: ['notifications'], refetchType: 'active' }],
    'other notifications do not reload task collections');
});

test('head, employee and permission changes refresh computed leave/ticket queues once per batch', (t) => {
  const live = useLiveHarness(t);
  live.status('SUBSCRIBED');
  live.invalidations.length = 0;
  live.handlers.get('role_assignments')({ eventType: 'DELETE', old: { id: 'head-grant', user_id: 'head' } });
  live.handlers.get('employees')({ eventType: 'UPDATE', new: { id: 'head-employee', status: 'Inactive' } });
  t.mock.timers.tick(999);
  assert.equal(live.invalidations.length, 0);
  t.mock.timers.tick(1);
  for (const key of ['leaves', 'leaves-period', 'leave-balances', 'ticket-access', 'ticket-categories', 'tickets', 'notification-ref-statuses']) {
    assert.equal(live.invalidations.filter(entry => entry.queryKey[0] === key).length, 1, `${key} updates even without a request-row event`);
  }
  assert.ok(live.invalidations.every(entry => entry.refetchType === 'active'));
  assert.equal(live.accessRefreshes, 0, 'a known other employee change does not reload the current identity');
  for (const table of ['roles', 'role_permissions', 'profiles']) {
    live.invalidations.length = 0;
    live.handlers.get(table)({ eventType: 'UPDATE', new: { id: 'permission-change', user_id: 'me' } });
    t.mock.timers.tick(1_000);
    for (const key of ['leaves', 'ticket-access', 'ticket-categories', 'tickets']) {
      assert.ok(live.invalidations.some(entry => entry.queryKey[0] === key), `${table} refreshes ${key}`);
    }
  }
  assert.equal(live.accessRefreshes, 3, 'current role/profile changes refresh auth capabilities');
});

test('a current employee transfer and a primary-key-only grant deletion refresh current access', (t) => {
  const live = useLiveHarness(t);
  live.status('SUBSCRIBED');
  live.invalidations.length = 0;
  live.handlers.get('employees')({ eventType: 'UPDATE', new: { id: 'employee-me', department_id: 'new-department' } });
  live.handlers.get('role_assignments')({ eventType: 'DELETE', old: { id: 'removed-grant' } });
  t.mock.timers.tick(1_000);
  assert.equal(live.accessRefreshes, 1, 'identity and grant changes coalesce into one access refresh');
  assert.equal(live.invalidations.filter(entry => entry.queryKey[0] === 'ticket-access').length, 1);
  assert.equal(live.invalidations.filter(entry => entry.queryKey[0] === 'leaves').length, 1);
});

test('routine assignment and completion events refresh Home and period statistics in one batch', (t) => {
  const live = useLiveHarness(t);
  live.status('SUBSCRIBED');
  live.invalidations.length = 0;
  live.handlers.get('routine_sets')({ eventType: 'INSERT', new: { id: 'new-routine' } });
  live.handlers.get('routine_items')({ eventType: 'INSERT', new: { id: 'new-job' } });
  live.handlers.get('routine_ticks')({ eventType: 'INSERT', new: { id: 'completion' } });
  t.mock.timers.tick(1_000);
  for (const key of ['routine-day', 'routine-sets', 'routine-stats']) {
    assert.equal(live.invalidations.filter(entry => entry.queryKey[0] === key).length, 1);
  }
  live.invalidations.length = 0;
  live.handlers.get('designations')({ eventType: 'UPDATE', new: { id: 'cashier', title: 'Senior Cashier' } });
  t.mock.timers.tick(1_000);
  for (const key of ['routine-day', 'routine-sets', 'routine-stats', 'employees']) {
    assert.ok(live.invalidations.some(entry => entry.queryKey[0] === key));
  }
});

test('hidden realtime changes mark mounted and cached screens stale without fetching until visible', async (t) => {
  const live = useLiveHarness(t);
  let reads = 0;
  live.client.setQueryData(['goals'], [{ id: 'before' }]);
  live.client.setQueryData(['goals', 'cached-view'], [{ id: 'cached' }]);
  const observer = new QueryObserver(live.client, { queryKey: ['goals'], staleTime: 60_000,
    queryFn: async () => { reads++; return [{ id: 'after' }]; } });
  const unsubscribe = observer.subscribe(() => {});
  t.after(unsubscribe);
  live.status('SUBSCRIBED');
  assert.equal(reads, 0, 'initial subscription respects the fresh query cache');
  globalThis.document.visibilityState = 'hidden';
  live.handlers.get('goals')({ eventType: 'INSERT', new: { id: 'after' } });
  t.mock.timers.tick(1000);
  assert.equal(reads, 0);
  assert.equal(live.client.getQueryState(['goals']).isInvalidated, true);
  assert.equal(live.client.getQueryState(['goals', 'cached-view']).isInvalidated, true,
    'an unmounted screen must not later show a fresh-but-outdated cache');
  globalThis.document.visibilityState = 'visible';
  live.events.get('visibilitychange')();
  assert.equal(reads, 1);
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(live.client.getQueryData(['goals']), [{ id: 'after' }]);
  live.events.get('visibilitychange')();
  assert.equal(reads, 1, 'another visibility event honors the newly refreshed cache');
});

test('initial socket and foreground events join an in-flight read, while reconnect catches missed changes', async (t) => {
  const live = useLiveHarness(t);
  let reads = 0, release;
  const observer = new QueryObserver(live.client, { queryKey: ['goals'], staleTime: 60_000,
    queryFn: () => { reads++; return new Promise(resolve => { release = resolve; }); } });
  const unsubscribe = observer.subscribe(() => {});
  t.after(unsubscribe);
  assert.equal(reads, 1);
  live.status('SUBSCRIBED');
  live.events.get('visibilitychange')();
  assert.equal(reads, 1);
  release([]);
  await Promise.resolve(); await Promise.resolve();
  live.status('SUBSCRIBED');
  assert.equal(reads, 2, 'a reconnect invalidates even fresh answers to catch socket gaps');
  release([]);
  await Promise.resolve();
});

test('a response started before a hidden change cannot erase the required foreground refresh', async (t) => {
  const live = useLiveHarness(t);
  let reads = 0, release;
  const observer = new QueryObserver(live.client, { queryKey: ['goals'], staleTime: 60_000,
    queryFn: () => { reads++; return new Promise(resolve => { release = resolve; }); } });
  const unsubscribe = observer.subscribe(() => {});
  t.after(unsubscribe);
  live.status('SUBSCRIBED');
  globalThis.document.visibilityState = 'hidden';
  live.handlers.get('goals')({ eventType: 'INSERT', new: { id: 'new-goal' } });
  t.mock.timers.tick(1000);
  release([{ id: 'old-snapshot' }]);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(live.client.getQueryState(['goals']).isInvalidated, false,
    'a completed query clears its invalidated flag even though it started before the event');
  globalThis.document.visibilityState = 'visible';
  live.events.get('visibilitychange')();
  assert.equal(reads, 2, 'the independent dirty set still starts a fresh read');
  release([{ id: 'new-goal' }]);
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(live.client.getQueryData(['goals']), [{ id: 'new-goal' }]);
});

test('the first subscription catches up a fresh inbox while retaining fresh ordinary data', async (t) => {
  const live = useLiveHarness(t);
  let chatReads = 0, orgReads = 0;
  live.client.setQueryData(['conversations'], { unread: 0 });
  live.client.setQueryData(['org'], { branches: ['known'] });
  const inbox = new QueryObserver(live.client, { queryKey: ['conversations'], staleTime: 60_000,
    queryFn: async () => { chatReads++; return { unread: 1 }; } });
  const org = new QueryObserver(live.client, { queryKey: ['org'], staleTime: 300_000,
    queryFn: async () => { orgReads++; return { branches: ['known'] }; } });
  t.after(inbox.subscribe(() => {}));
  t.after(org.subscribe(() => {}));
  live.status('SUBSCRIBED');
  await settle();
  assert.equal(chatReads, 1, 'messages missed before the socket became ready refresh immediately');
  assert.deepEqual(live.client.getQueryData(['conversations']), { unread: 1 });
  assert.equal(orgReads, 0, 'chat catch-up does not discard the reference-data cache');
});

test('a chat read begun before subscription cannot overwrite the initial catch-up response', async (t) => {
  const live = useLiveHarness(t);
  const releases = [];
  const observer = new QueryObserver(live.client, { queryKey: ['conversations'], staleTime: 60_000,
    queryFn: () => new Promise(resolve => releases.push(resolve)) });
  t.after(observer.subscribe(() => {}));
  assert.equal(releases.length, 1);
  live.status('SUBSCRIBED');
  await settle();
  assert.equal(releases.length, 2, 'first subscription replaces an in-flight initial chat load');
  releases[1]({ unread: 1 });
  await settle();
  releases[0]({ unread: 0 });
  await settle();
  assert.deepEqual(live.client.getQueryData(['conversations']), { unread: 1 });
});

test('foreground catch-up replaces a still-pending initial read even when no cached data exists', async (t) => {
  const live = useLiveHarness(t);
  const releases = [];
  const observer = new QueryObserver(live.client, { queryKey: ['goals'], staleTime: 60_000,
    queryFn: () => new Promise(resolve => releases.push(resolve)) });
  t.after(observer.subscribe(() => {}));
  live.status('SUBSCRIBED');
  globalThis.document.visibilityState = 'hidden';
  live.handlers.get('goals')({ eventType: 'INSERT', new: { id: 'new-goal' } });
  t.mock.timers.tick(1000);
  assert.equal(releases.length, 1, 'a hidden event starts no extra reads');
  globalThis.document.visibilityState = 'visible';
  live.events.get('visibilitychange')();
  await settle();
  assert.equal(releases.length, 2, 'foreground must replace rather than join the pre-event initial load');
  releases[1]([{ id: 'new-goal' }]);
  await settle();
  releases[0]([]);
  await settle();
  assert.deepEqual(live.client.getQueryData(['goals']), [{ id: 'new-goal' }]);
  live.events.get('visibilitychange')();
  assert.equal(releases.length, 2);
});

test('visible event bursts replace one initial snapshot after the batch, not once per event', async (t) => {
  const live = useLiveHarness(t);
  const releases = [];
  const observer = new QueryObserver(live.client, { queryKey: ['goals'], staleTime: 60_000,
    queryFn: () => new Promise(resolve => releases.push(resolve)) });
  t.after(observer.subscribe(() => {}));
  live.status('SUBSCRIBED');
  for (let i = 0; i < 50; i++) live.handlers.get('goals')({ eventType: 'UPDATE', new: { id: 'changed' } });
  t.mock.timers.tick(999);
  assert.equal(releases.length, 1);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(releases.length, 2, 'one replacement read covers the entire event batch');
  releases[1]([{ id: 'changed' }]);
  await settle();
  releases[0]([{ id: 'old' }]);
  await settle();
  assert.deepEqual(live.client.getQueryData(['goals']), [{ id: 'changed' }]);
});

test('an inactive pre-event read cannot repopulate a fresh stale snapshot and is only fetched on mount', async (t) => {
  const live = useLiveHarness(t);
  const releases = [];
  const options = { queryKey: ['goals', 'cached-screen'], staleTime: 60_000,
    queryFn: () => new Promise(resolve => releases.push(resolve)) };
  const initial = live.client.fetchQuery(options).catch(() => undefined);
  live.status('SUBSCRIBED');
  live.handlers.get('goals')({ eventType: 'UPDATE', new: { id: 'changed' } });
  t.mock.timers.tick(1000);
  await settle();
  releases[0]([{ id: 'old' }]);
  await initial;
  await settle();
  assert.equal(releases.length, 1, 'invalidation never fetches an unmounted screen');
  assert.equal(live.client.getQueryData(options.queryKey), undefined);
  assert.equal(live.client.getQueryState(options.queryKey).isInvalidated, true);
  const observer = new QueryObserver(live.client, options);
  t.after(observer.subscribe(() => {}));
  assert.equal(releases.length, 2);
  releases[1]([{ id: 'changed' }]);
  await settle();
  assert.deepEqual(live.client.getQueryData(options.queryKey), [{ id: 'changed' }]);
});
