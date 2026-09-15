export const TYPING_TTL_MS = 6000;
export const TYPING_THROTTLE_MS = 2000;
export const TYPING_IDLE_MS = 4000;
export const TYPING_POLL_MS = 2000;

export function isTypingUnavailable(error) {
  return ['42501', '42883', '42P01', 'PGRST202', 'PGRST205'].includes(error?.code);
}

function rowRevision(timestamp) {
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) return null;
  // Postgres timestamps have microseconds; preserve their ordering for a rapid start/stop.
  const fraction = String(timestamp).match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? '';
  return BigInt(milliseconds) * 1000n + BigInt(fraction.slice(3, 6).padEnd(3, '0'));
}

/** Serial writes prevent a delayed “typing” request from arriving after “stopped”. */
export function createTypingPublisher({ write, onError = () => {}, now = Date.now,
  schedule = setTimeout, cancel = clearTimeout, throttleMs = TYPING_THROTTLE_MS, idleMs = TYPING_IDLE_MS }) {
  let desired = false, sent = false, inFlight = false, disposed = false;
  let lastWrite = -Infinity, throttleTimer, idleTimer, activityVersion = 0;
  const clearTimers = () => { cancel(throttleTimer); cancel(idleTimer); throttleTimer = idleTimer = undefined; };
  const flush = () => {
    cancel(throttleTimer); throttleTimer = undefined;
    if (inFlight || (!desired && !sent)) return;
    // Starting again after a stop should appear on the first keystroke.
    if (desired && sent && now() - lastWrite < throttleMs) {
      throttleTimer = schedule(flush, throttleMs - (now() - lastWrite));
      return;
    }
    const value = desired, version = activityVersion;
    let failed = false;
    inFlight = true;
    sent = value;
    if (value) lastWrite = now();
    Promise.resolve().then(() => write(value)).catch((error) => { failed = true; onError(error); }).finally(() => {
      inFlight = false;
      // Keystrokes arriving while a slow RPC is running still need a heartbeat afterward.
      // A transient failure retries at the same throttle while the draft is actively typed.
      if (desired !== value || (desired && (failed || activityVersion !== version))) flush();
    });
  };
  const stop = () => { desired = false; clearTimers(); flush(); };
  return {
    setTyping(value) {
      if (disposed) return;
      if (!value) { stop(); return; }
      desired = true;
      activityVersion += 1;
      cancel(idleTimer);
      idleTimer = schedule(stop, idleMs);
      flush();
    },
    stop,
    dispose() { disposed = true; stop(); },
  };
}

/** Realtime first; short polling keeps ephemeral activity usable while a socket reconnects. */
export function subscribeToTyping({ client, conversationId, me, onChange, isVisible = () => true,
  now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
  const roster = createTypingRoster({ conversationId, me, now });
  let closed = false, active = true, connected = false, readBlocked = false, version = 0;
  let refreshing = false, refreshAgain = false, nextPoll = now() + TYPING_POLL_MS, timer;
  const paint = () => { if (!closed) onChange(roster); };
  const clear = () => { version += 1; roster.clear(); paint(); };
  const refresh = async () => {
    if (closed || !active || readBlocked || !isVisible()) return;
    if (refreshing) { refreshAgain = true; return; }
    refreshing = true;
    const requestVersion = version;
    const checkpoint = roster.checkpoint();
    try {
      let query = client.from('chat_typing')
        .select('id,conversation_id,employee_id,is_typing,updated_at,expires_at')
        .eq('is_typing', true).neq('employee_id', me);
      if (conversationId) query = query.eq('conversation_id', conversationId);
      const { data, error } = await query;
      if (closed || !active || !isVisible() || requestVersion !== version) return;
      if (error) { readBlocked = isTypingUnavailable(error); clear(); return; }
      roster.reconcile(data ?? [], checkpoint);
      paint();
    } catch (error) {
      if (!closed && requestVersion === version) { readBlocked = isTypingUnavailable(error); clear(); }
    }
    finally {
      refreshing = false;
      if (refreshAgain) { refreshAgain = false; void refresh(); }
    }
  };
  const channel = client.channel(conversationId ? `chat-typing:${conversationId}:${me}` : `inbox-typing:${me}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_typing',
      ...(conversationId ? { filter: `conversation_id=eq.${conversationId}` } : {}) }, (payload) => {
      if (closed || !active || !isVisible()) return;
      if (payload.eventType === 'DELETE') roster.remove(payload.old?.id);
      else roster.upsert(payload.new);
      paint();
    }).subscribe((status) => {
      if (closed || !active) return;
      connected = status === 'SUBSCRIBED';
      if (connected) void refresh();
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        clear();
        void refresh();
      }
    });
  const tick = () => {
    if (closed) return;
    if (active && isVisible()) {
      paint(); // Expiry still clears a lost stop event without any network response.
      if (!connected && now() >= nextPoll) {
        nextPoll = now() + TYPING_POLL_MS;
        if (!refreshing) void refresh();
      }
    }
    timer = schedule(tick, 250);
  };
  timer = schedule(tick, 250);
  void refresh();
  return {
    refresh,
    clear,
    endSession() { active = false; clear(); },
    dispose() { closed = true; version += 1; cancel(timer); client.removeChannel(channel); },
  };
}

/** A room roster, or the RLS-scoped inbox when conversationId is omitted. */
export function createTypingRoster({ conversationId, me, now = Date.now }) {
  const rows = new Map();
  const revisions = new Map();
  const expire = () => { for (const [id, row] of rows) if (row.expires <= now()) rows.delete(id); };
  return {
    checkpoint() { return new Map([...rows.keys()].map((id) => [id, revisions.get(id)])); },
    reconcile(snapshot, checkpoint) {
      const present = new Set(snapshot.map((row) => row.id));
      // A missing active row means stopped/expired/revoked. Preserve events newer than this read.
      for (const [id, revision] of checkpoint) {
        if (!present.has(id) && revisions.get(id) === revision) rows.delete(id);
      }
      for (const row of snapshot) this.upsert(row);
    },
    upsert(row) {
      if (!row?.id || !row.conversation_id || (conversationId && row.conversation_id !== conversationId)
          || !row.employee_id || row.employee_id === me) return;
      const revision = rowRevision(row.updated_at);
      if (revision === null || revision <= (revisions.get(row.id) ?? -Infinity)) return;
      revisions.set(row.id, revision);
      const expires = Math.min(Date.parse(row.expires_at), now() + TYPING_TTL_MS);
      if (row.is_typing === true && Number.isFinite(expires) && expires > now()) {
        rows.set(row.id, { conversationId: row.conversation_id, employeeId: row.employee_id, expires });
      }
      else rows.delete(row.id);
    },
    remove(id) {
      // DELETE events carry only the opaque primary key. Ignore keys never read in this room.
      if (!revisions.has(id)) return;
      revisions.set(id, Infinity);
      rows.delete(id);
    },
    ids() {
      expire();
      return [...new Set([...rows.values()].map((row) => row.employeeId))].sort();
    },
    byConversation() {
      expire();
      const groups = new Map();
      for (const row of rows.values()) {
        if (!groups.has(row.conversationId)) groups.set(row.conversationId, new Set());
        groups.get(row.conversationId).add(row.employeeId);
      }
      return Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b))
        .map(([id, employees]) => [id, [...employees].sort()]));
    },
    clear() { rows.clear(); revisions.clear(); },
  };
}

export function bindTypingLifecycle({ publisher, auth, userId, windowTarget, documentTarget,
  onHidden = () => {}, onVisible = () => {}, onSessionEnd = () => {} }) {
  const stop = () => publisher.stop();
  const resume = () => { if (documentTarget.visibilityState === 'visible') onVisible(); };
  const visibility = () => {
    if (documentTarget.visibilityState !== 'visible') { stop(); onHidden(); }
    else onVisible();
  };
  const { data } = auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT' || session?.user?.id !== userId) {
      onSessionEnd(); // Prevent a cleanup RPC from being sent as a newly signed-in account.
      stop();
      onHidden();
    }
  });
  windowTarget.addEventListener('blur', stop);
  windowTarget.addEventListener('pagehide', stop);
  windowTarget.addEventListener('focus', resume);
  windowTarget.addEventListener('online', resume);
  windowTarget.addEventListener('pageshow', resume);
  documentTarget.addEventListener('visibilitychange', visibility);
  return () => {
    data.subscription.unsubscribe();
    windowTarget.removeEventListener('blur', stop);
    windowTarget.removeEventListener('pagehide', stop);
    windowTarget.removeEventListener('focus', resume);
    windowTarget.removeEventListener('online', resume);
    windowTarget.removeEventListener('pageshow', resume);
    documentTarget.removeEventListener('visibilitychange', visibility);
  };
}
