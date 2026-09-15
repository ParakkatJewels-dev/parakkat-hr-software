// Notifications as a screen, not a dropdown.
//
// The bell's panel is 19rem wide and hangs off the header. On a phone that is most of the viewport
// held up by an absolutely-positioned box inside a header that clips it — the reported symptom was
// simply "I can't see it". A list you scroll is a page, so on small screens the bell opens this and
// the dropdown stays for the pointer-and-hover case it was designed for.
//
// Grouped by age the way a social feed does it, because that is the question you actually have —
// what happened since I last looked — and a flat list of 40 rows with a relative timestamp on each
// makes you compute it yourself.
//
// The row markup lives in ui/NotificationRow.jsx, which both this and the bell import — see the
// note there for why it is not declared in either of them.
import React, { useEffect, useMemo, useState } from 'react';
import { CheckCheck, AlertTriangle } from 'lucide-react';
import { NotificationRow, EmptyState } from './ui/NotificationRow';
import {
  useNotificationPage,
  useOpenNotification,
  useMarkAllNotificationsRead,
} from '../data/notifications';
import Pagination from './ui/Pagination';
import { paginationWindow } from '../lib/pagination';
import { humanDbError } from '../lib/dbErrors';
import { Skeleton, SkeletonRows } from './ui/Skeleton';

/** Midnight-based buckets: "today" has to mean the calendar day, not the last 24 hours. */
function bucketOf(iso) {
  const then = new Date(iso);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const days = Math.floor((startOfToday.getTime() - then.getTime()) / 86_400_000);

  if (then >= startOfToday) return 'Today';
  if (days < 1) return 'Yesterday';
  if (days < 7) return 'This week';
  if (days < 30) return 'This month';
  return 'Earlier';
}

const ORDER = ['Today', 'Yesterday', 'This week', 'This month', 'Earlier'];
const EMPTY_NOTIFICATIONS = [];

export default function Notifications({ onNavigate }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const history = useNotificationPage(page, pageSize);
  const notifications = history.data?.rows ?? EMPTY_NOTIFICATIONS;
  const unreadCount = history.data?.unreadCount ?? 0;
  const pager = paginationWindow(history.data?.count ?? 0, page, pageSize);
  const isLoading = history.isLoading || history.isPlaceholderData;
  useEffect(() => {
    if (history.data && !history.isPlaceholderData && page !== pager.page) setPage(pager.page);
  }, [history.data, history.isPlaceholderData, page, pager.page]);
  const { open: openItem, error: markError } = useOpenNotification(onNavigate);
  const markAllRead = useMarkAllNotificationsRead();

  const groups = useMemo(() => {
    const m = new Map();
    for (const n of notifications) {
      const b = bucketOf(n.created_at);
      if (!m.has(b)) m.set(b, []);
      m.get(b).push(n);
    }
    return ORDER.filter((b) => m.has(b)).map((b) => [b, m.get(b)]);
  }, [notifications]);

  return (
    <div className="page-shell space-y-4 animate-fade-in">
      <div className="mobile-list-row flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-neutral-900 dark:text-white leading-tight font-sans">Notifications</h1>
          {isLoading ? <Skeleton className="h-3 w-52 mt-1.5" /> : <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
            {unreadCount > 0 ? `${unreadCount} unread` : 'Everything here has been read.'} · {pager.count} notifications
          </p>}
        </div>
        {unreadCount > 0 && (
          <button
            onClick={() => markAllRead.mutate()}
            className="flex items-center gap-1.5 text-2xs font-bold text-neutral-600 dark:text-neutral-300 hover:text-black dark:hover:text-brand-ink px-2.5 py-1.5 bg-neutral-100 dark:bg-charcoal-800 rounded-xl transition-colors cursor-pointer shrink-0"
          >
            <CheckCheck size={12} /> Mark all read
          </button>
        )}
      </div>

      {/* A mark-read that reached no row now says so instead of leaving the badge stuck. This is
          the only one of the three surfaces with room to show it. */}
      {(history.error || markError || markAllRead.error) && (
        <div role="alert" className="flex items-start gap-2 text-xs text-red-600 dark:text-red-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{humanDbError(history.error || markError || markAllRead.error)}</span>
        </div>
      )}

      {isLoading ? <SkeletonRows rows={6} trailing={false} label="Loading notifications" /> : history.error ? null : notifications.length === 0 ? (
        <div className="premium-card"><EmptyState /></div>
      ) : (
        groups.map(([label, items]) => (
          <section key={label} className="space-y-1.5">
            {/* Sticky, so the bucket you are reading stays named while you scroll a long list. */}
            <h2 className="sticky top-0 z-10 text-2xs font-bold uppercase tracking-widest text-neutral-450 dark:text-neutral-500 bg-[var(--surface)] py-1.5">
              {label}
            </h2>
            <div className="premium-card p-0 overflow-hidden">
              {items.map((n) => (
                <NotificationRow key={n.id} n={n} onOpen={openItem} />
              ))}
            </div>
          </section>
        ))
      )}
      <Pagination {...pager} setPage={setPage} setPageSize={(size) => { setPageSize(size); setPage(1); }}
        noun="notifications" sizes={[25, 50, 100]} initialPageSize={25} disabled={history.isFetching} />
    </div>
  );
}
