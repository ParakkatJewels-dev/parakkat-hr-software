import UnreadMessageBadge from './UnreadMessageBadge';
import './countBadge.css';

/** Exact accessible count, with a compact visual label. Navigation supplies its own button name. */
export default function CountBadge({ count, singular = 'item needing action', plural = 'items needing action', corner = false, decorative = false }) {
  if (!Number.isSafeInteger(count) || count <= 0) return null;
  const label = `${count} ${count === 1 ? singular : plural}`;
  return <span role={decorative ? undefined : 'img'} aria-hidden={decorative ? 'true' : undefined} aria-label={decorative ? undefined : label}
    title={label} className={`count-badge${corner ? ' count-badge-corner' : ''}`}>
    {count > 99 ? '99+' : count}
  </span>;
}

export function NavigationCountBadge({ badge, corner = false }) {
  if (!badge) return null;
  return badge.unread ? <UnreadMessageBadge count={badge.count} corner={corner} />
    : <CountBadge {...badge} corner={corner} decorative />;
}

/** One notice per navigation surface; missing values do not become a row of misleading zeroes. */
export function NavigationCountStatus({ message, label = 'Counts unavailable', compact = false }) {
  if (!message) return null;
  return <span role="status" title={message} className={`navigation-count-status${compact ? ' navigation-count-status-compact' : ''}`}>
    <span aria-hidden="true" className="navigation-count-status-icon">!</span>
    <span className="sr-only">{message}</span>
    {!compact && <span aria-hidden="true">{label}</span>}
  </span>;
}
