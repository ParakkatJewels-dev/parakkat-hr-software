import { useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';

// Payroll drafts must survive route unmounts, but must never enter the persisted query cache
// or browser storage. The app replaces its QueryClient when the authenticated access scope
// changes, so each scope receives a separate store. An unreachable client and its store are
// eligible for garbage collection; same-client navigation retains entries for that session.
// QueryClient.clear() intentionally does not erase this memory. Callers clear completed or
// discarded drafts with the returned setter. Retain ordinary state values, not credentials.
const sessions = new WeakMap();

/** Read without initializing entries: run controls must not shadow a later editor's initializer. */
export function hasPayrollSessionChanges(client, entityId, period) {
  const entries = sessions.get(client);
  if (!entries || !entityId) return false;
  const read = key => entries.get(JSON.stringify(key))?.getSnapshot();
  const inputs = period ? read(['inputs', entityId, period]) : undefined;
  const preview = period ? read(['preview', entityId, period]) : undefined;
  const transactions = period ? read(['transactions', entityId, period]) : undefined;
  const policy = read(['policy', entityId]);
  const salary = read(['salary-setup']);
  // A salary change can affect any calculated month for its company. Merely opening the editor
  // is safe; a retained edit must be saved or discarded before calculating or publishing.
  const salaryDirty = salary?.entityId === entityId
    && JSON.stringify(salary.form) !== JSON.stringify(salary.initialForm);
  return Boolean((inputs && Object.keys(inputs).length > 0) || preview != null || policy?.dirty || transactions?.dirty || salaryDirty);
}

/** Check retained drafts at unload time, including editors hidden by another payroll view. */
export function hasAnyPayrollSessionChanges(client) {
  const entries = sessions.get(client);
  if (!entries) return false;
  for (const [serialized, entry] of entries) {
    const key = JSON.parse(serialized);
    if (!Array.isArray(key)) continue;
    if (['inputs', 'preview', 'policy', 'transactions'].includes(key[0]) && hasPayrollSessionChanges(client, key[1], key[2])) return true;
    const salary = key[0] === 'salary-setup' ? entry.getSnapshot() : null;
    if (salary && JSON.stringify(salary.form) !== JSON.stringify(salary.initialForm)) return true;
  }
  return false;
}

/** Internal entry helper, exported for tests without a React renderer. Keys must serialize to JSON. */
export function getPayrollSessionStateEntry(client, key, initialValue) {
  if (client === null || !['object', 'function'].includes(typeof client)) {
    throw new Error('Payroll session state requires a QueryClient.');
  }
  const serialized = JSON.stringify(key);
  if (serialized === undefined) throw new Error('Payroll session state requires a JSON-serializable key.');
  let entries = sessions.get(client);
  if (!entries) { entries = new Map(); sessions.set(client, entries); }
  if (entries.has(serialized)) return entries.get(serialized);

  let value = typeof initialValue === 'function' ? initialValue() : initialValue;
  const listeners = new Set();
  const entry = Object.freeze({
    getSnapshot: () => value,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: update => {
      const next = typeof update === 'function' ? update(value) : update;
      if (Object.is(value, next)) return;
      // Commit synchronously: functional updates and a route remount always see the newest
      // retained value, including updates made while no component is subscribed.
      value = next;
      for (const listener of [...listeners]) listener();
    },
  });
  entries.set(serialized, entry);
  return entry;
}

/** A useState-like [value, setter] retained in memory for this access scope and serialized key. */
export function usePayrollSessionState(key, initialValue) {
  const client = useQueryClient();
  const entry = getPayrollSessionStateEntry(client, key, initialValue);
  const value = useSyncExternalStore(entry.subscribe, entry.getSnapshot, entry.getSnapshot);
  return [value, entry.set];
}

export default usePayrollSessionState;
