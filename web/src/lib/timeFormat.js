// The reader's choice of 12- or 24-hour clock.
//
// Deliberately not React context. Times are formatted in a dozen places — the roster, the per-person
// table, the punch timeline, the dashboard widgets, the CSV export — and several of them call a
// plain imported function rather than a hook. Threading a provider through all of that would mean
// rewriting every call site, and the export is not a component at all.
//
// So the preference lives in a module store and useSyncExternalStore subscribes to it. Existing
// calls like fmtTime(row.check_in) keep working and read the current choice; a component that shows
// times calls useClockFormat() so it re-renders when the choice changes. Same pattern as the theme,
// which is also stored outside React and read at the point of use.
import { useSyncExternalStore } from 'react';

const KEY = 'clock-format';

/**
 * 24-hour by default.
 *
 * It was already the shared default in data/attendance.js, and it is what Easy Time Pro prints — so
 * a figure read off this screen matches the one read off theirs without translation.
 */
function read() {
  try {
    return window.localStorage.getItem(KEY) === '12';
  } catch {
    // Private browsing or a locked-down policy. The clock still works, it just does not remember.
    return false;
  }
}

let hour12 = read();
const listeners = new Set();

export function getHour12() {
  return hour12;
}

export function setHour12(next) {
  const value = Boolean(next);
  if (value === hour12) return;
  hour12 = value;
  try {
    window.localStorage.setItem(KEY, value ? '12' : '24');
  } catch {
    // Not remembering it is better than failing to apply it.
  }
  for (const l of listeners) l();
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Read the choice, and re-render when it changes.
 *
 * Any component that prints a time should call this even if it formats through an imported helper —
 * that is what makes the switch take effect immediately instead of on the next unrelated render.
 */
export function useClockFormat() {
  const value = useSyncExternalStore(subscribe, getHour12, () => false);
  return { hour12: value, setHour12 };
}
