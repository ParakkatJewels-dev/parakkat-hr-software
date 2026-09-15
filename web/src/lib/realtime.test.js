import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { QueryClient } from '@tanstack/query-core';
import { messageDeliveryStatus } from './messageReceipts.js';

const stubs = {
  react: 'export const useEffect = effect => { globalThis.liveTest.cleanup = effect(); };',
  '@tanstack/react-query': 'export const useQueryClient = () => globalThis.liveTest.client;',
  supabaseClient: 'export const supabase = { channel: (...args) => globalThis.liveTest.channel(...args), realtime: { setAuth: () => {} }, removeChannel: () => globalThis.liveTest.removed() };',
  AuthContext: 'export const useAuth = () => ({ session: { access_token: "test-token" }, user: { id: "me" }, reloadAccess: () => {} });',
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

function useLiveHarness(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const handlers = new Map(), invalidations = [], events = new Map();
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  const invalidate = client.invalidateQueries.bind(client);
  client.invalidateQueries = (...args) => { invalidations.push(args[0]); return invalidate(...args); };
  const oldDocument = globalThis.document;
  globalThis.document = { visibilityState: 'visible',
    addEventListener: (name, handler) => events.set(name, handler), removeEventListener: name => events.delete(name) };
  const state = { client, invalidations, handlers, events,
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
  assert.ok(live.invalidations.every(value => value.type === 'active'));
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
    { queryKey: ['notifications'], type: 'active' },
    { queryKey: ['tasks'], type: 'active' },
    { queryKey: ['notification-ref-statuses'], type: 'active' },
  ]);
  live.invalidations.length = 0;
  notify({ eventType: 'INSERT', new: { id: 'chat-1', type: 'message', ref_id: 'room-1' } });
  t.mock.timers.tick(1_000);
  assert.deepEqual(live.invalidations, [{ queryKey: ['notifications'], type: 'active' }],
    'other notifications do not reload task collections');
});
