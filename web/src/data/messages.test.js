import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers';

// Exercise the real message mutation and inspect exactly what reaches the database boundary.
const stubs = {
  '@tanstack/react-query': `export const useQuery = x => globalThis.messageTestQueryResult?.(x) ?? x;
    export const useInfiniteQuery = x => x;
    export const useMutation = x => ({ ...x, mutateAsync: async variables => {
      const result = await x.mutationFn(variables); x.onSuccess?.(result, variables); return result;
    } });
    export const useQueryClient = () => ({ invalidateQueries: options => globalThis.messageTestInvalidations?.push(options.queryKey) });`,
  react: `export const useMemo = fn => fn(); export const useRef = value => ({ current: value });
    export const useEffect = fn => { globalThis.messageTestEffects?.push(fn); };`,
  supabaseClient: `export const supabase = { from: (...args) => globalThis.messageTestDb.from(...args),
    rpc: (...args) => globalThis.messageTestDb.rpc(...args) };`,
  AuthContext: 'export const useAuth = () => ({ employee: { id: "employee-1" } });',
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

const { useSendMessage, useStartDirect, useRespondToMessageRequest, useMarkRead, useMarkDelivered, useIncomingMessageDelivery } = await import('./messages.js');

test('sending or retrying uploaded voice notes inserts integer milliseconds', async () => {
  const inserted = [];
  globalThis.messageTestDb = {
    from(table) {
      assert.equal(table, 'messages');
      return { async insert(row) {
        assert.ok(row.duration_ms === null || Number.isInteger(row.duration_ms), 'duration_ms must satisfy the integer column');
        inserted.push(row);
        return { error: null };
      } };
    },
  };
  const cases = [
    [6191.5999999996275, 6192],
    [6191.4, 6191],
    [6192, 6192],
    [0, 0],
    [null, null],
    [undefined, null],
    [NaN, null],
    [Infinity, null],
  ];
  for (const [durationMs, expected] of cases) {
    const media = { path: 'conversation/already-uploaded.webm', mimeType: 'audio/webm', byteSize: 1234, durationMs };
    await useSendMessage().mutationFn({ conversationId: 'conversation', kind: 'voice', media });
    assert.equal(inserted.at(-1).duration_ms, expected);
    assert.equal(inserted.at(-1).storage_path, media.path);
    assert.equal(media.durationMs, durationMs, 'retry metadata is not mutated');
  }
});

test('text messages keep an absent audio duration as null', async () => {
  globalThis.messageTestDb = {
    from() { return { async insert(row) {
      assert.equal(row.duration_ms, null);
      assert.equal(row.body, 'Hello');
      return { error: null };
    } }; },
  };
  await useSendMessage().mutationFn({ conversationId: 'conversation', body: 'Hello' });
});

test('starting a direct conversation uses one atomic RPC and never falls back to partial table writes', async () => {
  const calls = [];
  globalThis.messageTestDb = {
    from() { assert.fail('Direct conversations and both memberships must be created atomically'); },
    async rpc(name, params) { calls.push({ name, params }); return { data: 'conversation-1' }; },
  };
  const start = useStartDirect();
  assert.equal(await start.mutationFn({ employeeId: 'colleague-2' }), 'conversation-1');
  assert.deepEqual(calls, [{ name: 'start_direct_conversation', params: { _employee_id: 'colleague-2' } }]);
  await assert.rejects(start.mutationFn({ employeeId: 'employee-1' }), /yourself/);
  await assert.rejects(start.mutationFn({}), /No colleague/);
  assert.equal(calls.length, 1);
  const error = { code: '42501', message: 'Colleague unavailable' };
  globalThis.messageTestDb.rpc = async () => ({ error });
  await assert.rejects(start.mutationFn({ employeeId: 'colleague-2' }), result => result === error);
});

test('request decisions send an explicit accept or decline and propagate server authorization failures', async () => {
  const calls = [];
  globalThis.messageTestDb = { async rpc(name, params) { calls.push({ name, params }); return {}; } };
  const respond = useRespondToMessageRequest();
  for (const accept of [true, false]) await respond.mutationFn({ conversationId: 'request-1', accept });
  assert.deepEqual(calls, [true, false].map(accept => ({ name: 'respond_to_message_request', params: {
    _conversation_id: 'request-1', _accept: accept,
  } })));
  await assert.rejects(respond.mutationFn({ conversationId: 'request-1' }), /accept or decline/);
  const error = { code: '42501', message: 'Only the recipient can accept this request' };
  globalThis.messageTestDb.rpc = async () => ({ error });
  await assert.rejects(respond.mutationFn({ conversationId: 'request-1', accept: true }), result => result === error);
});

test('delivery and seen acknowledge fetched IDs without client timestamps or another recipient identity', async () => {
  const calls = [];
  globalThis.messageTestDb = {
    from() { assert.fail('Receipts must use authenticated server cursors, not client timestamp updates'); },
    async rpc(name, params) { calls.push({ name, params }); return {}; },
  };
  for (const [makeHook, seen] of [[useMarkDelivered, false], [useMarkRead, true]]) {
    const mutation = makeHook();
    await mutation.mutationFn({ conversationId: 'room-1', messageIds: ['received-1', 'received-1', '', null, 'received-2'] });
    assert.deepEqual(calls.at(-1), { name: 'acknowledge_message_receipts', params: {
      _conversation_id: 'room-1', _message_ids: ['received-1', 'received-2'], _seen: seen,
    } });
    await mutation.mutationFn({ conversationId: 'room-1', messageIds: [] });
    await mutation.mutationFn({ messageIds: ['received-1'] });
  }
  assert.equal(calls.length, 2, 'empty and unscoped acknowledgements must be skipped');
  const error = { code: '42501', message: 'Not a conversation member' };
  globalThis.messageTestDb.rpc = async () => ({ error });
  await assert.rejects(useMarkRead().mutationFn({ conversationId: 'room-1', messageIds: ['received-1'] }), result => result === error);
});

test('large fetched message sets stay within the server receipt batch limit', async () => {
  const batches = [];
  globalThis.messageTestDb = { async rpc(_name, params) {
    assert.ok(params._message_ids.length <= 1000);
    batches.push(params._message_ids);
    return {};
  } };
  const ids = Array.from({ length: 2025 }, (_, i) => `message-${i}`);
  await useMarkRead().mutationFn({ conversationId: 'room-1', messageIds: ids });
  assert.deepEqual(batches.map(batch => batch.length), [1000, 1000, 25]);
  assert.deepEqual(batches.flat(), ids);
});

test('the app delivery hook acknowledges new fetched inbox cursors once, never seen, and retries failed delivery', async () => {
  const receivedAt = '2026-09-12T10:00:00.123456+00:00';
  const ids = ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'];
  const calls = [];
  const query = { isSuccess: true, dataUpdatedAt: 1, data: [
    { id: 'pending-request', last_incoming_message_id: ids[1], last_incoming_message_created_at: receivedAt },
    { id: 'already-delivered', last_incoming_message_id: ids[0], last_incoming_message_created_at: receivedAt,
      last_delivered_at: receivedAt, last_delivered_message_id: ids[0] },
    { id: 'same-time-newer-id', last_incoming_message_id: ids[1], last_incoming_message_created_at: receivedAt,
      last_delivered_at: receivedAt, last_delivered_message_id: ids[0] },
    { id: 'own-messages-only', last_incoming_message_id: null, last_incoming_message_created_at: null },
  ] };
  let failOnce = true;
  globalThis.messageTestEffects = [];
  globalThis.messageTestQueryResult = options => {
    assert.deepEqual(options.queryKey, ['message-delivery', 'employee-1']);
    assert.equal(options.refetchInterval, 30_000);
    assert.equal(options.refetchIntervalInBackground, false);
    return query;
  };
  globalThis.messageTestDb = { async rpc(name, params) {
    calls.push({ name, params });
    if (params._conversation_id === 'pending-request' && failOnce) {
      failOnce = false;
      return { error: new Error('Temporarily offline') };
    }
    return {};
  } };
  try {
    useIncomingMessageDelivery();
    const [effect] = globalThis.messageTestEffects;
    effect();
    effect();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 2, 'duplicate renders cannot repeat in-flight delivery');
    effect();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 3, 'only the failed cursor is retried');
    effect();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 3, 'successful receipts cannot cause an acknowledgement loop');
    assert.deepEqual(calls.map(call => call.params._conversation_id), ['pending-request', 'same-time-newer-id', 'pending-request']);
    assert.ok(calls.every(call => call.name === 'acknowledge_message_receipts' && call.params._seen === false));
    assert.ok(calls.every(call => call.params._message_ids.length === 1 && call.params._message_ids[0] === ids[1]));
  } finally {
    delete globalThis.messageTestEffects;
    delete globalThis.messageTestQueryResult;
  }
});

test('the app delivery hook never acknowledges an inbox fetch that failed', () => {
  globalThis.messageTestEffects = [];
  globalThis.messageTestQueryResult = () => ({ isSuccess: false, data: [{ id: 'room-1', last_incoming_message_id: 'message-1' }] });
  globalThis.messageTestDb = { rpc() { assert.fail('A failed inbox fetch cannot confirm delivery'); } };
  try {
    useIncomingMessageDelivery();
    globalThis.messageTestEffects[0]();
  } finally {
    delete globalThis.messageTestEffects;
    delete globalThis.messageTestQueryResult;
  }
});
