// Header notification bell: unread badge, and what happens when you press it.
//
// On a pointer it opens the dropdown below. On a phone it does NOT — the panel is 19rem wide,
// absolutely positioned inside a header that clips it, and the report was simply "I can't see it".
// There it navigates to the notifications screen instead, which is a page you can scroll with a
// thumb. The row markup and the icon map come from that screen so the two cannot drift.
import React, { useState, useRef, useEffect } from 'react';
import { Bell, CheckCheck } from 'lucide-react';
import {
  useNotifications,
  useOpenNotification,
  useMarkAllNotificationsRead,
} from '../data/notifications';
import { NotificationRow, EmptyState } from './ui/NotificationRow';
import { useMediaQuery } from '../lib/useMediaQuery';
import { useSectionCounts } from '../data/sectionCounts';
import { usePermissions } from '../auth/usePermissions';
import { navigationCountLabel, navigationScreenCount } from '../lib/navigationCounts';
import { NavigationCountBadge } from './ui/CountBadge';

export default function NotificationBell({ onNavigate }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  // Matches Tailwind's lg breakpoint, which is where the sidebar appears and the layout stops being
  // a phone. Below it the dropdown is replaced by the full screen rather than restyled.
  const hasRoomForDropdown = useMediaQuery('(min-width: 1024px)');

  const { data: notifications = [] } = useNotifications();
  const { viewingAsEmployee } = usePermissions();
  const sectionCounts = useSectionCounts({ selfOnly: viewingAsEmployee });
  // The preview deliberately stops at 40 rows. Its unread subset is not the inbox total.
  const badge = navigationScreenCount('notifications', sectionCounts.data);
  const unreadCount = badge?.count;
  const label = navigationCountLabel('Notifications', badge);
  // `open` is taken by the dropdown's own state, so name the shared action for what it does.
  const { open: openNotification } = useOpenNotification(onNavigate);
  const markAllRead = useMarkAllNotificationsRead();

  // Keep acknowledgement available if the summary is unavailable but the preview proves there
  // is unread work. That partial preview must never be presented as an exact navigation count.
  const hasUnread = unreadCount == null ? notifications.some((n) => !n.read_at) : unreadCount > 0;

  // Close on outside click / Escape
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const openItem = (n) => {
    setOpen(false);
    openNotification(n);
  };

  return (
    <div className="header-notifications relative" ref={wrapRef}>
      <button
        onClick={() => (hasRoomForDropdown ? setOpen((v) => !v) : onNavigate?.('notifications'))}
        className="p-2 hover:bg-neutral-100 dark:hover:bg-neutral-900 rounded-xl text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white transition-colors cursor-pointer relative"
        title={label} aria-label={label}
      >
        <span className="relative inline-flex">
          <Bell size={16} />
          <NavigationCountBadge badge={badge} corner />
        </span>
      </button>

      {open && hasRoomForDropdown && (
        <div className="notification-panel absolute right-0 top-full mt-2 w-[min(19rem,calc(100vw-1rem))] sm:w-80 max-h-[70vh] flex flex-col bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 rounded-2xl shadow-2xl z-50 overflow-hidden animate-fade-in">
          <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-neutral-150 dark:border-neutral-900">
            <span className="text-xs font-bold text-neutral-800 dark:text-warm-gray-100">
              Notifications
              {unreadCount > 0 && (
                <span className="ml-1.5 text-2xs font-semibold text-neutral-450 dark:text-neutral-500">
                  {unreadCount} unread
                </span>
              )}
            </span>
            {hasUnread && (
              <button
                onClick={() => markAllRead.mutate()}
                className="flex items-center gap-1 text-2xs font-bold text-neutral-500 hover:text-black dark:hover:text-brand-ink px-1.5 py-0.5 bg-neutral-100 dark:bg-charcoal-800 rounded transition-all cursor-pointer"
              >
                <CheckCheck size={10} /> Mark all read
              </button>
            )}
          </div>

          <div className="overflow-y-auto">
            {notifications.length === 0 ? (
              <EmptyState compact />
            ) : (
              notifications.map((n) => (
                <NotificationRow key={n.id} n={n} onOpen={openItem} compact />
              ))
            )}
          </div>
          <button type="button" onClick={() => { setOpen(false); onNavigate?.('notifications'); }}
            className="shrink-0 border-t border-neutral-150 dark:border-neutral-900 px-3.5 py-3 text-xs font-semibold text-brand-ink hover:bg-neutral-50 dark:hover:bg-neutral-900 cursor-pointer">
            View all notifications
          </button>
        </div>
      )}
    </div>
  );
}
