import './unreadMessageBadge.css';

export function unreadMessageLabel(label, count) {
  return count > 0 ? `${label}, ${count} unread message${count === 1 ? '' : 's'}` : label;
}

// The parent button includes the exact count in its accessible name. Keep the visual badge short.
export default function UnreadMessageBadge({ count, corner = false }) {
  if (!(count > 0)) return null;
  return <span aria-hidden="true" className={`unread-message-badge${corner ? ' unread-message-badge-corner' : ''}`}>
    {count > 99 ? '99+' : count}
  </span>;
}
