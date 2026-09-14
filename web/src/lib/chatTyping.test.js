import test from 'node:test';
import assert from 'node:assert/strict';
import { bindTypingLifecycle, createTypingPublisher, createTypingRoster, TYPING_TTL_MS } from './chatTyping.js';

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
  callback('SIGNED_IN', { user: { id: 'user-two' } });
  callback('SIGNED_OUT', null);
  assert.equal(stops, 5); assert.equal(ended, 2);
  remove();
  assert.equal(unsubscribed, true); assert.equal(windowTarget.count(), 0); assert.equal(documentTarget.count(), 0);
});
