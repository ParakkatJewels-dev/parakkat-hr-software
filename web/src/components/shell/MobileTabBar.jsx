// The phone tab bar (2026 redesign, round 2): a flat white bar on the bottom edge with an icon and
// a small label per destination, the current one in coral, as in the reference phone kit. It
// replaces the floating glass capsule; the badges, labels and current-page rules are unchanged.
import React, { useState } from 'react';
import { NavigationCountBadge, NavigationCountStatus } from '../ui/CountBadge';
import { navigationCountLabel, navigationScreenCount } from '../../lib/navigationCounts';

export default function MobileTabBar({ items, activeId, currentId = activeId, onSelect, menuOpen = false, isPwaInstalled = false, countStatus = null }) {
  const [failedAvatar, setFailedAvatar] = useState(null);
  return (
    <nav className="mobile-bottom-nav lg:hidden" aria-label="Primary mobile navigation" data-pwa={isPwaInstalled ? 'true' : 'false'}>
      <NavigationCountStatus {...countStatus} compact />
      {items.map((item) => {
        const Icon = item.icon;
        // More opens the menu; it is never the current page (see mobileSectionActive).
        const active = item.id === activeId && item.id !== 'menu';
        const badge = item.badge ?? (item.id === 'messages' ? navigationScreenCount('messages', null, item.unreadCount) : null);
        return (
          <button key={item.id} type="button" disabled={item.disabled}
            className={`mobile-bottom-nav-item${active ? ' mobile-bottom-nav-item-active' : ''}`}
            aria-label={navigationCountLabel(item.label, badge)} aria-current={active && item.id === currentId ? 'page' : undefined}
            aria-haspopup={item.id === 'menu' ? 'dialog' : undefined}
            aria-controls={item.id === 'menu' ? 'mobile-navigation' : undefined}
            aria-expanded={item.id === 'menu' ? menuOpen : undefined}
            onClick={(event) => onSelect(item, event)}>
            <span className="mobile-bottom-nav-icon" aria-hidden="true">
              {item.id === 'profile' ? (
                <span className="mobile-bottom-nav-avatar">
                  {item.avatarUrl && item.avatarUrl !== failedAvatar
                    ? <img src={item.avatarUrl} alt="" draggable="false" onError={() => setFailedAvatar(item.avatarUrl)} />
                    : item.initials || 'Me'}
                </span>
              ) : (
                <span className="nav-message-icon">
                  {Icon && <Icon size={22} />}
                  <NavigationCountBadge badge={badge} corner />
                </span>
              )}
            </span>
            <span className="mobile-bottom-nav-label" aria-hidden="true">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
