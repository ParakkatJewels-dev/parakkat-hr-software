import { fetchPage } from './fetchPage.js';

/** Full notification history stays on the server; the bell keeps its recent preview. */
export async function fetchNotificationPage(client, { page = 1, pageSize = 25 } = {}) {
  const [history, unread] = await Promise.all([
    fetchPage(() => client.from('notifications')
      .select('id, type, title, body, tab, ref_id, read_at, created_at', { count: 'exact' })
      .order('created_at', { ascending: false }).order('id', { ascending: false }), { page, pageSize }),
    client.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null),
  ]);
  if (unread.error) throw unread.error;
  return { ...history, unreadCount: unread.count ?? 0 };
}
