// The section's screens as tabs under the page title, coral underline on the current one.
// `.section-tab-button[aria-current="page"]` is what App scrolls into view on a route change.
//
// `views` is for a screen that has views of its own (Attendance: Today · Exceptions · Corrections).
// On a computer those stay as the screen's own row of pills under these tabs. On a phone two rows
// of pills is one too many, so this draws one row: the screen's views in place of its own tab,
// then the section's other screens. The screen hides its own row on a phone.
import React, { useLayoutEffect, useRef } from 'react';
import { NavigationCountBadge } from '../ui/CountBadge';
import { navigationCountLabel } from '../../lib/navigationCounts';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { useShellNav } from './shellNavContext';

/** The one row a phone shows: views where the current screen's tab was. */
export function mergedTabs(sectionTabs, activeTab, views) {
  const out = [];
  let placed = false;
  for (const tab of sectionTabs) {
    if (tab.id === activeTab) {
      for (const view of views.items) out.push({ key: `view:${view.id}`, view, label: view.shortLabel ?? view.label, badge: view.badge ?? null, on: views.active === view.id });
      placed = true;
    } else out.push({ key: tab.id, tab, label: tab.label, on: false });
  }
  if (!placed) for (const view of views.items) out.unshift({ key: `view:${view.id}`, view, label: view.shortLabel ?? view.label, badge: view.badge ?? null, on: views.active === view.id });
  return out;
}

export default function SectionTabs({ views }) {
  const nav = useShellNav();
  const phone = useMediaQuery('(max-width: 640px)');
  const scroller = useRef(null);
  const section = nav?.section;
  const merged = Boolean(views && phone);
  const activeKey = merged ? views.active : nav?.activeTab;

  // Keep the current pill in sight: a long row used to leave it scrolled off the right edge.
  useLayoutEffect(() => {
    const row = scroller.current;
    const on = row?.querySelector('[aria-current="page"]');
    if (!row || !on || row.scrollWidth <= row.clientWidth) return;
    const left = on.offsetLeft - row.offsetLeft;
    if (left < row.scrollLeft || left + on.offsetWidth > row.scrollLeft + row.clientWidth) {
      row.scrollLeft = Math.max(0, left - (row.clientWidth - on.offsetWidth) / 2);
    }
  }, [activeKey, merged]);

  if (!section) return null;
  if (!merged && section.tabs.length < 2) return null;
  const items = merged
    ? mergedTabs(section.tabs, nav.activeTab, views)
    : section.tabs.map((tab) => ({ key: tab.id, tab, label: tab.label, on: nav.activeTab === tab.id }));
  return (
    <nav aria-label={`${section.label} sections`} className={`section-tabbar ${merged ? 'is-merged' : ''}`}>
      <div className="section-tab-scroll" ref={scroller}>
        {items.map((item) => {
          const badge = item.view ? item.badge : nav.screenBadge(item.tab.id);
          return (
            <button key={item.key} type="button"
              onClick={() => (item.view ? views.onSelect(item.view.id) : nav.select(nav.navTarget(item.tab)))}
              aria-current={item.on ? 'page' : undefined} aria-label={navigationCountLabel(item.view?.label ?? item.label, badge)}
              className={`section-tab-button ${item.on ? 'is-active' : ''} ${item.view ? 'is-view' : ''}`}>
              {item.label}<NavigationCountBadge badge={badge} />
            </button>
          );
        })}
      </div>
    </nav>
  );
}
