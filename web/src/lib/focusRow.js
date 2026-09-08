// Deep-linking a notification to the ROW it is about, not just the screen it lives on.
//
// A notification already stores `ref_id` — the leave request, the task, the ticket it was raised
// for — and threw it away at click time, so a manager with forty pending requests landed on a list
// and searched it by hand for the one the app had just told them about.
//
// Carried as a QUERY parameter rather than a path segment, because the second segment is already
// spoken for: urlTab.js reads `/screen/tab` as a page's inner tab, so `/attendance/<uuid>` would
// read as an inner tab named after a uuid and fall back to the default. `?focus=` sits beside that
// instead of fighting it, and HashRouter carries it fine (`#/attendance/regularizations?focus=…`).
//
// Pure and dependency-free, like urlTab.js beside it, so the rules can be tested without a router.
// The React half is useFocusRow.js.

export const FOCUS_PARAM = 'focus';

/** The row a URL is asking to focus, or null. `search` is `location.search` ('?focus=…'). */
export function focusIdFrom(search) {
  const raw = new URLSearchParams(String(search ?? '')).get(FOCUS_PARAM);
  const id = raw?.trim();
  return id ? id : null;
}

/**
 * The same search string with the focus removed.
 *
 * Consumed, not sticky: once the row has been pointed at, the parameter has done its job. Leaving
 * it in the URL means a refresh re-scrolls, the Back button re-highlights something you already
 * dealt with, and a copied link carries a row id that may be meaningless to the person you send it
 * to. Everything else in the query string survives.
 */
export function stripFocus(search) {
  const params = new URLSearchParams(String(search ?? ''));
  params.delete(FOCUS_PARAM);
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

/**
 * Where a notification should send you: its tab, plus the row when there is exactly one.
 *
 * A grouped row on the dashboard strip stands for several notifications — "New leave request ×3" —
 * and there is no honest answer to "which one". Those get the screen and no focus rather than an
 * arbitrary pick of the three.
 */
export function notificationTarget(n) {
  if (!n?.tab) return null;
  const single = Array.isArray(n.ids) ? n.ids.length === 1 : true;
  return single && n.ref_id ? `${n.tab}?${FOCUS_PARAM}=${encodeURIComponent(n.ref_id)}` : n.tab;
}

/** 1-based page holding `id`, or null when the list does not contain it. */
export function pageContaining(items, id, pageSize) {
  if (!id || !pageSize) return null;
  const i = (items ?? []).findIndex((row) => row?.id === id);
  return i < 0 ? null : Math.floor(i / pageSize) + 1;
}

/**
 * Is the app being asked to focus a row that is not on screen?
 *
 * Deliberately distinguishes "not in this filtered view" from "not loaded yet": while the list is
 * still empty there is nothing to conclude, and saying "that item is no longer available" during a
 * load would be a lie that then corrects itself.
 */
export function focusIsMissing(focusId, visibleItems, { loaded = true } = {}) {
  if (!focusId || !loaded) return false;
  return !(visibleItems ?? []).some((row) => row?.id === focusId);
}
