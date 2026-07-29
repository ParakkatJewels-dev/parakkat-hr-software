// A page's own tab bar, kept in the URL instead of in component state.
//
// App.jsx routes the screen — the first path segment — so a refresh returns to Attendance rather
// than the dashboard. That was only half the journey: every tabbed page still held its inner tab in
// useState, so refreshing on Attendance > Sync status came back on Attendance > Today, and whoever
// was reading the sync log had to find their way back to it. This carries the second segment.
//
// The rules live in urlTab.js, without React or the router, so they can be tested directly.
import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { tabFromPath, pathForTab } from './urlTab';

/**
 * Drop-in replacement for `useState(defaultTab)` on a page's tab bar.
 *
 * Returns [tab, setTab] so call sites are unchanged. `valid` is the tab ids this page actually has;
 * see tabFromPath for why a URL naming an unknown one falls back rather than rendering empty.
 *
 * Switching tabs REPLACES the history entry rather than pushing one. Pushing sounds right until you
 * follow it through: click across six tabs looking for something, then press Back expecting to
 * leave the page and instead walk back through all six. The screen is the navigation step; its tabs
 * are a view of it.
 */
export function useUrlTab(defaultTab, valid) {
  const { pathname } = useLocation();
  const navigate = useNavigate();

  const tab = tabFromPath(pathname, defaultTab, valid);

  const setTab = useCallback(
    (next) => navigate(pathForTab(pathname, next), { replace: true }),
    [navigate, pathname]
  );

  return [tab, setTab];
}

export default useUrlTab;
