// The desktop sidebar (2026 redesign): a floating forest-green panel, sections under their group
// headings, the current one as a coral pill. Collapses to icons; the state lives in App so the
// main panel can widen with it.
import React from 'react';
import { ChevronRight, LogOut, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import BrandMark from '../ui/BrandMark';
import { NavigationCountBadge, NavigationCountStatus } from '../ui/CountBadge';
import { navigationCountLabel } from '../../lib/navigationCounts';

export default function Sidebar({
  groups, activeSectionId, collapsed, onCollapsedChange, sectionBadge, onOpenSection, countStatus,
  identity, onOpenProfile, onSignOut, hidden,
}) {
  return (
    <aside inert={hidden || undefined} aria-hidden={hidden || undefined}
      className={`app-sidebar hidden lg:flex ${collapsed ? 'is-collapsed' : ''}`}>
      <div className="app-sidebar-brand">
        <span className="app-sidebar-logo" aria-hidden="true"><BrandMark size={collapsed ? 22 : 24} /></span>
        {!collapsed && (
          <span className="app-sidebar-wordmark">
            <strong>PARAKKAT</strong>
            <span>HRMS</span>
          </span>
        )}
        <button type="button" className="app-sidebar-collapse" onClick={() => onCollapsedChange(!collapsed)}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-label={collapsed ? 'Expand Sidebar' : 'Collapse Sidebar'}>
          {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
        </button>
      </div>

      <nav className="app-sidebar-nav" aria-label="Main">
        {groups.map((group) => (
          <div key={group.title ?? 'more'} className="app-sidebar-group">
            {group.title && !collapsed && <p className="app-sidebar-heading">{group.title}</p>}
            {group.title && collapsed && <span className="app-sidebar-divider" aria-hidden="true" />}
            {group.sections.map((sec) => {
              const Icon = sec.icon;
              const active = activeSectionId === sec.id;
              const badge = sectionBadge(sec);
              const label = navigationCountLabel(sec.label, badge);
              return (
                <button key={sec.id} type="button" onClick={() => onOpenSection(sec)}
                  aria-current={active ? 'page' : undefined} aria-label={label} title={collapsed ? label : undefined}
                  className={`app-sidebar-item group ${active ? 'is-active' : ''}`}>
                  <span className="nav-message-icon" aria-hidden="true">
                    <Icon size={collapsed ? 20 : 19} strokeWidth={1.8} />
                    {collapsed && <NavigationCountBadge badge={badge} corner />}
                  </span>
                  {!collapsed && <span className="app-sidebar-label">{sec.label}</span>}
                  {!collapsed && <NavigationCountBadge badge={badge} />}
                  {!collapsed && active && !badge && <span className="app-sidebar-dot" aria-hidden="true" />}
                  {collapsed && <span className="app-sidebar-tooltip" aria-hidden="true">{label}</span>}
                </button>
              );
            })}
          </div>
        ))}
        <NavigationCountStatus {...countStatus} compact={collapsed} />
      </nav>

      <div className="app-sidebar-footer">
        <button type="button" onClick={onOpenProfile} className="app-sidebar-user" title="Open my profile" aria-label="Open my profile">
          <span className="app-sidebar-avatar" aria-hidden="true">
            {identity.avatarUrl ? <img src={identity.avatarUrl} alt="" /> : identity.initials}
          </span>
          {!collapsed && (
            <span className="app-sidebar-user-copy">
              <strong>{identity.name}</strong>
              <span>{identity.subtitle}</span>
            </span>
          )}
          {!collapsed && <ChevronRight size={16} aria-hidden="true" className="app-sidebar-user-chevron" />}
        </button>
        <button type="button" onClick={onSignOut} className="app-sidebar-signout" title="Sign Out" aria-label="Sign Out">
          <LogOut size={16} />
        </button>
      </div>
    </aside>
  );
}
