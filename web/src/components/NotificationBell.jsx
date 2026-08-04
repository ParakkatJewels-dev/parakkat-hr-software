// Header notification bell: unread badge + dropdown. Clicking a notification marks it read and
// jumps to the module it came from (tab id stamped by the DB trigger). Live via realtime.js.
import React, { useState, useRef, useEffect } from 'react';
import { Bell, CheckCheck, Calendar, Receipt, ListChecks, Fingerprint, HelpCircle, Inbox } from 'lucide-react';
import {
  useNotifications,
  useMarkNotificationRead,
  useMarkAllNotificationsRead,
} from '../data/notifications';

const TYPE_ICONS = {
  leave: Calendar,
  expense: Receipt,
  task: ListChecks,
  regularization: Fingerprint,
  ticket: HelpCircle,
};

const timeAgo = (iso) => {
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d ago` : new Date(iso).toLocaleDateString();
};

export default function NotificationBell({ onNavigate }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  const { data: notifications = [] } = useNotifications();
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();

  const unread = notifications.filter((n) => !n.read_at);

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
    if (!n.read_at) markRead.mutate(n.id);
    setOpen(false);
    if (n.tab && onNavigate) onNavigate(n.tab);
  };

  return (
    <div className="relative" ref={wrapRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="p-2 hover:bg-neutral-100 dark:hover:bg-neutral-900 rounded-xl text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white transition-colors cursor-pointer relative"
        title="Notifications" aria-label="Notifications"
      >
        <Bell size={16} />
        {unread.length > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] px-0.5 bg-[#0ea971] dark:bg-[#10b981] text-white text-2xs font-bold rounded-full border border-white dark:border-charcoal-900 flex items-center justify-center leading-none">
            {unread.length > 9 ? '9+' : unread.length}
          </span>
        )}
      </button>

      {open && (
        <div className="notification-panel absolute right-0 top-full mt-2 w-[min(19rem,calc(100vw-1rem))] sm:w-80 max-h-[70vh] flex flex-col bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 rounded-2xl shadow-2xl z-50 overflow-hidden animate-fade-in">
          <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-neutral-150 dark:border-neutral-900">
            <span className="text-xs font-bold text-neutral-800 dark:text-warm-gray-100">
              Notifications
              {unread.length > 0 && (
                <span className="ml-1.5 text-2xs font-semibold text-neutral-450 dark:text-neutral-500">
                  {unread.length} unread
                </span>
              )}
            </span>
            {unread.length > 0 && (
              <button
                onClick={() => markAllRead.mutate()}
                className="flex items-center gap-1 text-2xs font-bold text-neutral-500 hover:text-black dark:hover:text-[#0ea971] px-1.5 py-0.5 bg-neutral-100 dark:bg-charcoal-800 rounded transition-all cursor-pointer"
              >
                <CheckCheck size={10} /> Mark all read
              </button>
            )}
          </div>

          <div className="overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="py-10 flex flex-col items-center text-center px-6">
                <Inbox size={20} className="text-neutral-300 dark:text-neutral-700 mb-2" />
                <span className="text-xs font-semibold text-neutral-500 dark:text-neutral-400">
                  You're all caught up
                </span>
                <span className="text-2xs text-neutral-400 dark:text-neutral-600 mt-0.5">
                  Approvals, tasks and requests will appear here.
                </span>
              </div>
            ) : (
              notifications.map((n) => {
                const Icon = TYPE_ICONS[n.type] || Bell;
                return (
                  <button
                    key={n.id}
                    onClick={() => openItem(n)}
                    className={`w-full text-left px-3.5 py-2.5 flex gap-2.5 border-b border-neutral-100 dark:border-neutral-900/60 last:border-b-0 transition-colors cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-900/40 ${
                      n.read_at ? 'opacity-70' : 'bg-neutral-50/60 dark:bg-charcoal-900/20'
                    }`}
                  >
                    <div className="w-7 h-7 rounded-lg bg-neutral-100 dark:bg-charcoal-800 text-neutral-600 dark:text-[#10b981] flex items-center justify-center shrink-0 mt-0.5">
                      <Icon size={13} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-base font-bold text-neutral-800 dark:text-warm-gray-100 truncate">
                          {n.title}
                        </span>
                        {!n.read_at && (
                          <span className="w-1.5 h-1.5 rounded-full bg-[#0ea971] dark:bg-[#10b981] shrink-0" />
                        )}
                      </div>
                      {n.body && (
                        <p className="text-2xs text-neutral-500 dark:text-neutral-400 leading-snug mt-0.5 line-clamp-2">
                          {n.body}
                        </p>
                      )}
                      <span className="block text-2xs text-neutral-400 dark:text-neutral-600 mt-1">
                        {timeAgo(n.created_at)}
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
