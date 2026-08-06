// One notification, rendered the same way wherever it appears.
//
// Its own module because BOTH the header bell and the full notifications screen draw these rows,
// and App.jsx lazy-loads the screen. With the shared markup living in the screen, the bell's import
// pulled the whole page back into the main bundle and the code-split silently did nothing — the
// build says so: "dynamically imported ... but also statically imported".
//
// Two copies would have been worse than a bigger bundle: "unread is tinted, the dot is on the
// right, the icon depends on the type" is exactly the kind of rule that drifts the first time
// either copy is touched.
import React from 'react';
import {
  Bell, Calendar, Receipt, ListChecks, Fingerprint, HelpCircle, Inbox, Boxes, FileText,
} from 'lucide-react';

export const TYPE_ICONS = {
  leave: Calendar,
  expense: Receipt,
  task: ListChecks,
  regularization: Fingerprint,
  ticket: HelpCircle,
  asset: Boxes,
  document: FileText,
};

export const timeAgo = (iso) => {
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d ago` : new Date(iso).toLocaleDateString();
};

/**
 * One notification. `compact` is the dropdown; the page gives it more room.
 *
 * Unread carries BOTH a tint and a dot on purpose: the tint alone is a colour difference of a few
 * percent, which disappears on a phone at arm's length in daylight and does not exist at all for a
 * reader who cannot distinguish it.
 */
export function NotificationRow({ n, onOpen, compact = false }) {
  const Icon = TYPE_ICONS[n.type] || Bell;
  return (
    <button
      onClick={() => onOpen(n)}
      className={`w-full text-left flex gap-3 border-b border-neutral-100 dark:border-neutral-900/60 last:border-b-0 transition-colors cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-900/40 ${
        compact ? 'px-3.5 py-2.5' : 'px-4 py-3.5'
      } ${n.read_at ? 'opacity-70' : 'bg-neutral-50/60 dark:bg-charcoal-900/20'}`}
    >
      <div
        className={`rounded-xl bg-neutral-100 dark:bg-charcoal-800 text-neutral-600 dark:text-[#10b981] flex items-center justify-center shrink-0 mt-0.5 ${
          compact ? 'w-7 h-7' : 'w-9 h-9'
        }`}
      >
        <Icon size={compact ? 13 : 16} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className={`font-bold text-neutral-800 dark:text-warm-gray-100 truncate ${compact ? 'text-base' : 'text-sm'}`}>
            {n.title}
          </span>
          {!n.read_at && <span className="w-2 h-2 rounded-full bg-[#0ea971] dark:bg-[#10b981] shrink-0" />}
        </div>
        {n.body && (
          <p className={`text-neutral-500 dark:text-neutral-400 leading-snug mt-0.5 ${compact ? 'text-2xs line-clamp-2' : 'text-xs'}`}>
            {n.body}
          </p>
        )}
        <span className="block text-2xs text-neutral-400 dark:text-neutral-600 mt-1">{timeAgo(n.created_at)}</span>
      </div>
    </button>
  );
}

export function EmptyState({ compact = false }) {
  return (
    <div className={`flex flex-col items-center text-center px-6 ${compact ? 'py-10' : 'py-20'}`}>
      <Inbox size={compact ? 20 : 28} className="text-neutral-300 dark:text-neutral-700 mb-2" />
      <span className="text-xs font-semibold text-neutral-500 dark:text-neutral-400">You're all caught up</span>
      <span className="text-2xs text-neutral-400 dark:text-neutral-600 mt-0.5">
        Approvals, tasks and requests will appear here.
      </span>
    </div>
  );
}

