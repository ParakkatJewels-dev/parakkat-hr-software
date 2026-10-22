// The page header — every screen opens with it (2026 redesign).
//
// Top to bottom:
//   breadcrumb  where you are: the section and the screen (People / Directory), or `crumbs`
//   title       the screen, as the page's one <h1>
//   subtitle    one line on what the screen is for; omit it rather than pad it
//   actions     right-aligned: outlined secondary first, the coral primary last (prop or children)
//   tabs        the section's screens, under the title (SectionTabs). `tabs={false}` for record
//               pages such as an employee profile, which have their own tabs.
//
// `eyebrow` is the older prop for a section label; it shows only when there is no breadcrumb.
import React from 'react';
import { ChevronRight } from 'lucide-react';
import SectionTabs from '../shell/SectionTabs';
import { useShellNav } from '../shell/shellNavContext';

function defaultCrumbs(nav) {
  const section = nav?.section;
  if (!section || section.tabs.length < 2) return null;
  const tab = section.tabs.find((t) => t.id === nav.activeTab);
  return [
    { label: section.label, onClick: () => nav.select(nav.navTarget(section.tabs[0])) },
    ...(tab ? [{ label: tab.label }] : []),
  ];
}

export default function PageHeader({ eyebrow, title, subtitle, actions: actionsProp, meta, crumbs, tabs = true, className = '', children }) {
  const nav = useShellNav();
  // Actions can come as a prop or as children, whichever reads better at the call site.
  const actions = actionsProp ?? children;
  const trail = (crumbs ?? defaultCrumbs(nav))?.map((c) => (typeof c === 'string' ? { label: c } : c)) ?? null;
  return (
    <div className={`page-header ${className}`}>
      <div className="page-header-row">
        <div className="page-header-copy">
          {trail?.length ? (
            <nav aria-label="Breadcrumb" className="page-header-crumbs">
              <ol>
                {trail.map((crumb, i) => {
                  const last = i === trail.length - 1;
                  return (
                    <li key={`${crumb.label}-${i}`}>
                      {crumb.onClick && !last
                        ? <button type="button" onClick={crumb.onClick}>{crumb.label}</button>
                        : <span aria-current={last ? 'page' : undefined}>{crumb.label}</span>}
                      {!last && <ChevronRight size={13} aria-hidden="true" />}
                    </li>
                  );
                })}
              </ol>
            </nav>
          ) : eyebrow ? <p className="page-header-crumbs page-header-eyebrow">{eyebrow}</p> : null}
          <h1 className="page-header-title">{title}</h1>
          {subtitle && (typeof subtitle === 'string'
            ? <p className="page-header-subtitle">{subtitle}</p>
            : <div className="page-header-subtitle">{subtitle}</div>)}
        </div>
        {(actions || meta) && (
          <div className="page-header-actions">
            {meta}
            {actions}
          </div>
        )}
      </div>
      {tabs && <SectionTabs />}
    </div>
  );
}
