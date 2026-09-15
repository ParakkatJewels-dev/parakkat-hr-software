import test from 'node:test';
import assert from 'node:assert/strict';
import { bindTypingLifecycle, createTypingPublisher, createTypingRoster, isTypingUnavailable, subscribeToTyping, TYPING_TTL_MS } from './chatTyping.js';

const settle = async () => { for (let turn = 0; turn < 8; turn += 1) await Promise.resolve(); };
function clock() {
  let time = 1700000000000, sequence = 0;
  const timers = new Map();
  return {
    now: () => time,
    schedule(callback, delay) { const id = ++sequence; timers.set(id, { at: time + delay, callback }); return id; },
    cancel(id) { timers.delete(id); },
    async advance(milliseconds) {
      const end = time + milliseconds;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); time = next[1].at; next[1].callback(); await settle();
      }
      time = end; await settle();
    },
    timers: () => timers.size,
  };
}
function publisherHarness() {
  const timer = clock();
  const writes = [];
  const publisher = createTypingPublisher({ ...timer, write: async (typing) => { writes.push({ typing, at: timer.now() }); } });
  return { timer, publisher, writes };
}

test('typing bursts publish at most once every two seconds and automatically stop after inactivity', async () => {
  const { timer, publisher, writes } = publisherHarness();
  publisher.setTyping(true); await settle();
  for (let i = 0; i < 45; i += 1) { await timer.advance(100); publisher.setTyping(true); await settle(); }
  const activeWrites = writes.filter((row) => row.typing);
  assert.equal(activeWrites.length, 3);
  for (let i = 1; i < activeWrites.length; i += 1) assert.ok(activeWrites[i].at - activeWrites[i - 1].at >= 2000);
  await timer.advance(4000);
  assert.equal(writes.at(-1).typing, false);
  assert.equal(timer.timers(), 0);
});

test('clearing a draft or sending stops immediately and cancels a trailing typing update', async () => {
  const { timer, publisher, writes } = publisherHarness();
  publisher.setTyping(true); await settle();
  await timer.advance(100); publisher.setTyping(true);
  publisher.setTyping(false); await settle();
  assert.deepEqual(writes.map((row) => row.typing), [true, false]);
  await timer.advance(10000);
  assert.deepEqual(writes.map((row) => row.typing), [true, false]);
});

test('empty drafts do not broadcast, and a disposed conversation cannot restart typing', async () => {
  const { timer, publisher, writes } = publisherHarness();
  publisher.setTyping(false); publisher.stop(); publisher.dispose(); publisher.setTyping(true);
  await timer.advance(10000);
  assert.deepEqual(writes, []);
  assert.equal(timer.timers(), 0);
});

test('switching or unmounting stops the old conversation and releases all scheduled work', async () => {
  const { timer, publisher, writes } = publisherHarness();
  publisher.setTyping(true); await settle();
  await timer.advance(100); publisher.setTyping(true);
  publisher.dispose(); await settle();
  await timer.advance(10000);
  assert.deepEqual(writes.map((row) => row.typing), [true, false]);
  assert.equal(timer.timers(), 0);
});

test('a delayed typing RPC finishes before the stop RPC, including during unmount', async () => {
  const timer = clock();
  const writes = [];
  let finishFirst;
  const publisher = createTypingPublisher({ ...timer, write: (typing) => {
    writes.push(typing);
    return typing ? new Promise((resolve) => { finishFirst = resolve; }) : Promise.resolve();
  } });
  publisher.setTyping(true); await settle();
  publisher.dispose(); await settle();
  assert.deepEqual(writes, [true]);
  finishFirst(); await settle();
  assert.deepEqual(writes, [true, false]);
  await timer.advance(10000);
  assert.equal(writes.length, 2);
});

test('a new draft starts immediately after a stop instead of waiting for the old throttle', async () => {
  const { timer, publisher, writes } = publisherHarness();
  publisher.setTyping(true); await settle();
  await timer.advance(100); publisher.stop(); await settle();
  publisher.setTyping(true); await settle();
  assert.deepEqual(writes.map((entry) => entry.typing), [true, false, true]);
  assert.equal(writes.at(-1).at, timer.now());
  publisher.dispose();
});

test('keystrokes during a slow request publish a fresh heartbeat after that request completes', async () => {
  const timer = clock(), writes = [];
  let finish;
  const publisher = createTypingPublisher({ ...timer, write: (typing) => {
    writes.push({ typing, at: timer.now() });
    if (writes.length === 1) return new Promise((resolve) => { finish = resolve; });
  } });
  publisher.setTyping(true); await settle();
  await timer.advance(1500); publisher.setTyping(true);
  await timer.advance(1500); publisher.setTyping(true);
  finish(); await settle();
  assert.deepEqual(writes.map((entry) => entry.typing), [true, true]);
  assert.equal(writes[1].at, timer.now());
  publisher.dispose(); await settle();
});

test('transient failures retry at the throttle and recover without reopening the conversation', async () => {
  const timer = clock(), writes = [], failures = [];
  const publisher = createTypingPublisher({ ...timer, onError: (error) => failures.push(error), write: async (typing) => {
    writes.push(typing);
    if (writes.length === 1) throw new TypeError('Failed to fetch');
  } });
  publisher.setTyping(true); await settle();
  await timer.advance(1999); assert.deepEqual(writes, [true]);
  await timer.advance(1); assert.deepEqual(writes, [true, true]);
  assert.equal(failures.length, 1);
  publisher.dispose(); await settle();
  await timer.advance(10000);
  assert.deepEqual(writes, [true, true, false]);
});

test('only unavailable schema or membership disables typing permanently', () => {
  for (const code of ['42501', '42883', '42P01', 'PGRST202', 'PGRST205']) assert.equal(isTypingUnavailable({ code }), true);
  for (const error of [new TypeError('Failed to fetch'), { status: 503 }, { code: 'PGRST301' }]) {
    assert.equal(isTypingUnavailable(error), false);
  }
});

const row = (now, changes = {}) => ({ id: 'row-one', conversation_id: 'room', employee_id: 'peer', is_typing: true,
  updated_at: new Date(now).toISOString(), expires_at: new Date(now + TYPING_TTL_MS).toISOString(), ...changes });

test('typing roster excludes self, other rooms, malformed timestamps and expired activity', () => {
  const timer = clock();
  const roster = createTypingRoster({ conversationId: 'room', me: 'self', now: timer.now });
  for (const changes of [
    { employee_id: 'self' }, { conversation_id: 'another-room' }, { updated_at: 'bad date' },
    { expires_at: 'bad date' }, { expires_at: new Date(timer.now() - 1).toISOString() }, { is_typing: false },
  ]) roster.upsert(row(timer.now(), changes));
  assert.deepEqual(roster.ids(), []);
  roster.upsert(row(timer.now(), { id: 'valid-peer' }));
  assert.deepEqual(roster.ids(), ['peer']);
});

test('lost stop events expire within six seconds without any network or new messages', async () => {
  const timer = clock();
  const roster = createTypingRoster({ conversationId: 'room', me: 'self', now: timer.now });
  roster.upsert(row(timer.now()));
  await timer.advance(5999); assert.deepEqual(roster.ids(), ['peer']);
  await timer.advance(1); assert.deepEqual(roster.ids(), []);
});

test('future timestamps or repeated snapshots cannot keep a peer typing beyond the local TTL', async () => {
  const timer = clock();
  const roster = createTypingRoster({ conversationId: 'room', me: 'self', now: timer.now });
  const future = row(timer.now(), { expires_at: new Date(timer.now() + 3600000).toISOString() });
  roster.upsert(future);
  await timer.advance(3000); roster.upsert(future);
  await timer.advance(3000); assert.deepEqual(roster.ids(), []);
});

test('late initial reads cannot resurrect a peer after a newer stop, including microsecond timestamps', () => {
  const timer = clock();
  const roster = createTypingRoster({ conversationId: 'room', me: 'self', now: timer.now });
  const base = new Date(timer.now()).toISOString().replace('.000Z', '.000100+00:00');
  const newer = base.replace('.000100', '.000101');
  const started = row(timer.now(), { updated_at: base });
  roster.upsert(started); assert.deepEqual(roster.ids(), ['peer']);
  roster.upsert({ ...started, updated_at: newer, is_typing: false });
  roster.upsert(started);
  assert.deepEqual(roster.ids(), []);
});

test('snapshots clear missing activity without erasing a newer realtime start or restoring a stopped peer', () => {
  const timer = clock();
  const roster = createTypingRoster({ conversationId: 'room', me: 'self', now: timer.now });
  const started = row(timer.now());
  roster.upsert(started);
  roster.reconcile([], roster.checkpoint());
  assert.deepEqual(roster.ids(), [], 'an absent active row stops on the next fallback read');
  const checkpoint = roster.checkpoint();
  const next = row(timer.now() + 1);
  roster.upsert(next);
  roster.reconcile([], checkpoint);
  assert.deepEqual(roster.ids(), ['peer'], 'a read started before new activity cannot erase it');
  const beforeStop = roster.checkpoint();
  roster.upsert(row(timer.now() + 2, { is_typing: false }));
  roster.reconcile([next], beforeStop);
  assert.deepEqual(roster.ids(), [], 'a late snapshot cannot resurrect a newer stop');
});

test('membership DELETE only removes a previously authorized opaque ID and rejects stale replay', () => {
  const timer = clock();
  const roster = createTypingRoster({ conversationId: 'room', me: 'self', now: timer.now });
  const active = row(timer.now());
  roster.upsert(active); roster.remove('unrelated-private-row');
  assert.deepEqual(roster.ids(), ['peer']);
  roster.remove(active.id); roster.upsert(active);
  assert.deepEqual(roster.ids(), []);
  roster.clear(); assert.deepEqual(roster.ids(), []);
});

test('one inbox roster groups actual peers by conversation and excludes the current employee', () => {
  const timer = clock();
  const roster = createTypingRoster({ me: 'self', now: timer.now });
  roster.upsert(row(timer.now(), { id: 'one', conversation_id: 'room-a', employee_id: 'peer-b' }));
  roster.upsert(row(timer.now(), { id: 'two', conversation_id: 'room-b', employee_id: 'peer-a' }));
  roster.upsert(row(timer.now(), { id: 'three', conversation_id: 'room-a', employee_id: 'peer-a' }));
  roster.upsert(row(timer.now(), { id: 'four', conversation_id: 'room-a', employee_id: 'self' }));
  assert.deepEqual(roster.byConversation(), { 'room-a': ['peer-a', 'peer-b'], 'room-b': ['peer-a'] });
  roster.remove('one');
  assert.deepEqual(roster.byConversation(), { 'room-a': ['peer-a'], 'room-b': ['peer-a'] });
});

test('inbox typing expires independently for each room and clears completely on auth cleanup', async () => {
  const timer = clock();
  const roster = createTypingRoster({ me: 'self', now: timer.now });
  roster.upsert(row(timer.now(), { id: 'one', conversation_id: 'room-a' }));
  await timer.advance(3000);
  roster.upsert(row(timer.now(), { id: 'two', conversation_id: 'room-b' }));
  await timer.advance(3000);
  assert.deepEqual(roster.byConversation(), { 'room-b': ['peer'] });
  roster.clear();
  assert.deepEqual(roster.byConversation(), {});
});

function target() {
  const listeners = new Map();
  return {
    visibilityState: 'visible',
    addEventListener(event, callback) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(callback); },
    removeEventListener(event, callback) { listeners.get(event)?.delete(callback); },
    emit(event) { for (const callback of listeners.get(event) ?? []) callback(); },
    count() { return [...listeners.values()].reduce((total, set) => total + set.size, 0); },
  };
}
test('blur, hidden tabs, page exit and logout stop activity; cleanup removes every listener', () => {
  const windowTarget = target(), documentTarget = target();
  let callback, unsubscribed = false, stops = 0, hidden = 0, visible = 0, ended = 0;
  const remove = bindTypingLifecycle({
    publisher: { stop: () => { stops += 1; } }, userId: 'user-one', windowTarget, documentTarget,
    auth: { onAuthStateChange: (listener) => { callback = listener; return { data: { subscription: { unsubscribe: () => { unsubscribed = true; } } } }; } },
    onHidden: () => { hidden += 1; }, onVisible: () => { visible += 1; }, onSessionEnd: () => { ended += 1; },
  });
  windowTarget.emit('blur'); windowTarget.emit('pagehide');
  documentTarget.visibilityState = 'hidden'; documentTarget.emit('visibilitychange');
  documentTarget.visibilityState = 'visible'; documentTarget.emit('visibilitychange');
  callback('TOKEN_REFRESHED', { user: { id: 'user-one' } });
  assert.equal(stops, 3); assert.equal(hidden, 1); assert.equal(visible, 1);
  windowTarget.emit('focus'); windowTarget.emit('online'); windowTarget.emit('pageshow');
  assert.equal(visible, 4, 'resume, reconnect, and browser back/forward restore fresh activity');
  callback('SIGNED_IN', { user: { id: 'user-two' } });
  callback('SIGNED_OUT', null);
  assert.equal(stops, 5); assert.equal(ended, 2);
  remove();
  assert.equal(unsubscribed, true); assert.equal(windowTarget.count(), 0); assert.equal(documentTarget.count(), 0);
});

function feedHarness(options = {}) {
  const timer = clock();
  let handler, status, visible = true, reads = 0, removed = 0;
  let answer = () => ({ data: [], error: null });
  const snapshots = [], queries = [];
  const client = {
    channel() {
      const channel = {
        on(_type, filter, callback) { handler = callback; channel.filter = filter; return channel; },
        subscribe(callback) { status = callback; return channel; },
      };
      return channel;
    },
    removeChannel() { removed += 1; },
    from(table) {
      const filters = [], query = {
        select() { return query; },
        eq(field, value) { filters.push([field, value]); return query; },
        neq(field, value) { filters.push([field, 'not', value]); return query; },
        then(resolve, reject) { reads += 1; queries.push({ table, filters }); return Promise.resolve(answer()).then(resolve, reject); },
      };
      return query;
    },
  };
  const feed = subscribeToTyping({ client, me: 'self', conversationId: 'room', ...options, ...timer,
    isVisible: () => visible, onChange: (roster) => snapshots.push(roster.byConversation()) });
  return { ...timer, feed, snapshots, queries,
    answer: (next) => { answer = next; },
    visible: (next) => { visible = next; },
    status: (next) => status(next), emit: (payload) => handler(payload),
    reads: () => reads, removed: () => removed };
}

test('typing events render immediately with no polling on a healthy socket; lost stops still expire', async () => {
  const h = feedHarness();
  await settle(); h.status('SUBSCRIBED'); await settle();
  const reads = h.reads();
  h.emit({ eventType: 'INSERT', new: row(h.now()) });
  assert.deepEqual(h.snapshots.at(-1), { room: ['peer'] });
  await h.advance(TYPING_TTL_MS);
  assert.deepEqual(h.snapshots.at(-1), {});
  assert.equal(h.reads(), reads);
  h.feed.dispose();
  assert.equal(h.timers(), 0); assert.equal(h.removed(), 1);
});

test('disconnected typing polls every two seconds and reconnecting returns to realtime', async () => {
  const h = feedHarness();
  await settle();
  h.answer(() => ({ data: [row(h.now())] }));
  h.status('CHANNEL_ERROR'); await settle();
  assert.deepEqual(h.snapshots.at(-1), { room: ['peer'] });
  h.answer(() => ({ data: [] }));
  await h.advance(2000);
  assert.deepEqual(h.snapshots.at(-1), {}, 'fallback also clears stopped activity');
  h.status('SUBSCRIBED'); await settle();
  const reads = h.reads();
  await h.advance(4000); assert.equal(h.reads(), reads);
  assert.ok(h.queries.every(({ table, filters }) => table === 'chat_typing'
    && filters.some(([field, value]) => field === 'conversation_id' && value === 'room')));
  h.feed.dispose();
});

test('slow fallback reads are coalesced and never discarded by the next polling interval', async () => {
  const h = feedHarness();
  let finish;
  h.answer(() => new Promise((resolve) => { finish = resolve; }));
  await settle();
  await h.advance(7000);
  assert.equal(h.reads(), 1);
  finish({ data: [row(h.now())] }); await settle();
  assert.deepEqual(h.snapshots.at(-1), { room: ['peer'] });
  h.feed.dispose();
});

test('hidden tabs and ended sessions make no typing reads and ignore late events', async () => {
  const h = feedHarness({ conversationId: undefined });
  await settle();
  h.emit({ eventType: 'INSERT', new: row(h.now(), { conversation_id: 'room-b' }) });
  assert.deepEqual(h.snapshots.at(-1), { 'room-b': ['peer'] });
  h.visible(false); h.feed.clear();
  const reads = h.reads();
  await h.advance(7000); assert.equal(h.reads(), reads);
  h.visible(true); await h.feed.refresh();
  assert.equal(h.reads(), reads + 1);
  h.feed.endSession();
  h.emit({ eventType: 'INSERT', new: row(h.now()) });
  await h.advance(7000); await h.feed.refresh();
  assert.equal(h.reads(), reads + 1);
  assert.deepEqual(h.snapshots.at(-1), {});
  assert.ok(h.queries.every(({ filters }) => !filters.some(([field]) => field === 'conversation_id')));
  h.feed.dispose();
});

test('restoring the tab during a stale in-flight read queues a fresh snapshot', async () => {
  const h = feedHarness();
  let finish;
  h.answer(() => new Promise((resolve) => { finish = resolve; }));
  await settle();
  h.visible(false); h.feed.clear();
  h.visible(true); void h.feed.refresh();
  h.answer(() => ({ data: [row(h.now(), { employee_id: 'new-peer', id: 'new-row' })] }));
  finish({ data: [row(h.now())] }); await settle();
  assert.equal(h.reads(), 2);
  assert.deepEqual(h.snapshots.at(-1), { room: ['new-peer'] });
  h.feed.dispose();
});

test('fallback recovers from a transient read error but stops querying a missing schema', async () => {
  const h = feedHarness();
  h.answer(() => ({ error: new TypeError('Network unavailable') }));
  await settle();
  h.answer(() => ({ data: [row(h.now())] }));
  await h.advance(2000);
  assert.deepEqual(h.snapshots.at(-1), { room: ['peer'] });
  h.answer(() => ({ error: { code: 'PGRST205', message: 'Missing table' } }));
  await h.advance(2000);
  const reads = h.reads();
  await h.advance(10000);
  assert.equal(h.reads(), reads);
  assert.deepEqual(h.snapshots.at(-1), {});
  h.feed.dispose();
});
