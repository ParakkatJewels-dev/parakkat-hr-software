export const TYPING_TTL_MS = 6000;
export const TYPING_THROTTLE_MS = 2000;
export const TYPING_IDLE_MS = 4000;

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
  let lastWrite = -Infinity, throttleTimer, idleTimer;
  const clearTimers = () => { cancel(throttleTimer); cancel(idleTimer); throttleTimer = idleTimer = undefined; };
  const flush = () => {
    cancel(throttleTimer); throttleTimer = undefined;
    if (inFlight || (!desired && !sent)) return;
    if (desired && now() - lastWrite < throttleMs) {
      throttleTimer = schedule(flush, throttleMs - (now() - lastWrite));
      return;
    }
    const value = desired;
    inFlight = true;
    sent = value;
    if (value) lastWrite = now();
    Promise.resolve().then(() => write(value)).catch(onError).finally(() => {
      inFlight = false;
      if (desired !== value) flush();
    });
  };
  const stop = () => { desired = false; clearTimers(); flush(); };
  return {
    setTyping(value) {
      if (disposed) return;
      if (!value) { stop(); return; }
      desired = true;
      cancel(idleTimer);
      idleTimer = schedule(stop, idleMs);
      flush();
    },
    stop,
    dispose() { disposed = true; stop(); },
  };
}

/** A room roster, or the RLS-scoped inbox when conversationId is omitted. */
export function createTypingRoster({ conversationId, me, now = Date.now }) {
  const rows = new Map();
  const revisions = new Map();
  const expire = () => { for (const [id, row] of rows) if (row.expires <= now()) rows.delete(id); };
  return {
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
  documentTarget.addEventListener('visibilitychange', visibility);
  return () => {
    data.subscription.unsubscribe();
    windowTarget.removeEventListener('blur', stop);
    windowTarget.removeEventListener('pagehide', stop);
    documentTarget.removeEventListener('visibilitychange', visibility);
  };
}
