// The page header — every screen opens with it (2026 redesign).
//
// Top to bottom:
//   breadcrumb  where you are: the section and the screen (People / Directory), or `crumbs`
//   title       the screen, as the page's one <h1>
//   subtitle    one line on what the screen is for; omit it rather than pad it
//   actions     right-aligned: outlined secondary first, the coral primary last (prop or children)
//   tabs        the section's screens, under the title (SectionTabs). `tabs={false}` for record
//               pages such as an employee profile, which have their own tabs.
//   views       a screen's own views, merged into the tabs on a phone (see SectionTabs).
//
// `eyebrow` is the older prop for a section label; it shows only when there is no breadcrumb.
//
// On a phone (round 2, after the reference phone kit) the header is the top of the page: screens
// under the bottom bar's sections keep a left-aligned title, and every other screen gets an app bar
// with a back arrow and a centred title. `back` overrides where the arrow goes (or `false` hides it).
import React from 'react';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import SectionTabs from '../shell/SectionTabs';
import { useShellNav } from '../shell/shellNavContext';
import { MOBILE_PRIMARY_IDS, mobileLitId } from '../../lib/navMap';

const BAR_ITEMS = MOBILE_PRIMARY_IDS.oversight.map((id) => ({ id }));

/** The back arrow a phone shows, or null on screens that belong to a bottom-bar section. */
export function phoneBackFor(nav) {
  if (!nav?.activeTab || mobileLitId(BAR_ITEMS, nav.activeTab)) return null;
  return () => {
    // React Router numbers its own history entries; go back only within the app, else to Home.
    const index = window.history.state?.idx;
    if (typeof index === 'number' && index > 0) window.history.back();
    else nav.select('dashboard');
  };
}

function defaultCrumbs(nav) {
  const section = nav?.section;
  if (!section || section.tabs.length < 2) return null;
  const tab = section.tabs.find((t) => t.id === nav.activeTab);
  return [
    { label: section.label, onClick: () => nav.select(nav.navTarget(section.tabs[0])) },
    ...(tab ? [{ label: tab.label }] : []),
  ];
}

export default function PageHeader({ eyebrow, title, subtitle, actions: actionsProp, meta, crumbs, tabs = true, views, back, className = '', children }) {
  const nav = useShellNav();
  // Actions can come as a prop or as children, whichever reads better at the call site.
  const actions = actionsProp ?? children;
  const trail = (crumbs ?? defaultCrumbs(nav))?.map((c) => (typeof c === 'string' ? { label: c } : c)) ?? null;
  const goBack = back === false ? null : back ?? phoneBackFor(nav);
  return (
    <div className={`page-header ${goBack ? 'has-back' : ''} ${className}`}>
      <div className="page-header-row">
        {goBack && (
          <button type="button" className="page-header-back" onClick={goBack} aria-label="Back">
            <ArrowLeft size={20} aria-hidden="true" />
          </button>
        )}
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
      {tabs && <SectionTabs views={views} />}
    </div>
  );
}
