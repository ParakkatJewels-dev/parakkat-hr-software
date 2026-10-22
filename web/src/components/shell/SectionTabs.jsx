// The section's screens as tabs under the page title, coral underline on the current one.
// `.section-tab-button[aria-current="page"]` is what App scrolls into view on a route change.
import React from 'react';
import { NavigationCountBadge } from '../ui/CountBadge';
import { navigationCountLabel } from '../../lib/navigationCounts';
import { useShellNav } from './shellNavContext';

export default function SectionTabs() {
  const nav = useShellNav();
  const section = nav?.section;
  if (!section || section.tabs.length < 2) return null;
  return (
    <nav aria-label={`${section.label} sections`} className="section-tabbar">
      <div className="section-tab-scroll">
        {section.tabs.map((tab) => {
          const on = nav.activeTab === tab.id;
          const badge = nav.screenBadge(tab.id);
          return (
            <button key={tab.id} type="button" onClick={() => nav.select(nav.navTarget(tab))}
              aria-current={on ? 'page' : undefined} aria-label={navigationCountLabel(tab.label, badge)}
              className={`section-tab-button ${on ? 'is-active' : ''}`}>
              {tab.label}<NavigationCountBadge badge={badge} />
            </button>
          );
        })}
      </div>
    </nav>
  );
}
