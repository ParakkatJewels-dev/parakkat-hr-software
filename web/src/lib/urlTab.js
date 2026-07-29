// Reading a page's screen and tab out of a URL path, and writing one back.
//
// Dependency-free on purpose — no React, no router — so the rules can be tested directly. The hook
// in useUrlTab.js is a thin wrapper over these two functions.
//
// The shape is `/screen/tab`: the first segment names the screen (App.jsx routes on it), the second
// names that screen's own tab. Everything is derived from the path, so a refresh, the Back button
// and a pasted link all agree about what should be on screen.

/** Strip the leading and trailing slashes and split. '/attendance/exceptions/' -> ['attendance','exceptions']. */
const segments = (pathname) => String(pathname ?? '').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);

/** The screen: the first segment, or '' at the root. */
export function screenFromPath(pathname) {
  return segments(pathname)[0] ?? '';
}

/**
 * The tab a path is asking for.
 *
 * Falls back to the default when the URL names a tab this page does not have — a stale bookmark, a
 * renamed tab, or one filtered out because the signed-in user lacks the permission for it. Without
 * that check the page would render its tab bar with nothing selected and no content below it,
 * which reads as a broken screen rather than as a bad link.
 */
export function tabFromPath(pathname, defaultTab, valid) {
  const asked = segments(pathname)[1] ?? '';
  if (!asked) return defaultTab;
  if (valid && !valid.includes(asked)) return defaultTab;
  return asked;
}

/** The path that selects `tab` on whatever screen `pathname` is currently on. */
export function pathForTab(pathname, tab) {
  return `/${screenFromPath(pathname)}/${tab}`;
}
