import { useSyncExternalStore } from 'react';
import { istToday } from './dates.js';

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 330 * 60_000;
const dateAt = (instant) => new Date(instant + IST_OFFSET_MS).toISOString().slice(0, 10);

/** IST has no daylight-saving transition. Allow 25 ms for the new date to settle. */
export function untilNextIstDay(instant) {
  return DAY_MS - ((instant + IST_OFFSET_MS) % DAY_MS + DAY_MS) % DAY_MS + 25;
}

/** One timer per subscriber, also refreshed when a suspended tab becomes visible again. */
export function watchIstDay(listener, {
  now = Date.now, schedule = setTimeout, cancel = clearTimeout, onWake,
} = {}) {
  let day = dateAt(now());
  let timer;
  const refresh = () => {
    const current = dateAt(now());
    if (current !== day) { day = current; listener(); }
    cancel(timer);
    timer = schedule(refresh, untilNextIstDay(now()));
  };
  timer = schedule(refresh, untilNextIstDay(now()));
  const stopWake = onWake?.(refresh);
  return () => { cancel(timer); stopWake?.(); };
}

const subscribe = (listener) => watchIstDay(listener, {
  onWake: (refresh) => {
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  },
});

export function useIstToday() {
  return useSyncExternalStore(subscribe, istToday, istToday);
}
