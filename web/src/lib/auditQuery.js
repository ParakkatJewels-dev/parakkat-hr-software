import { textContainsFilter } from './querySearch.js';
import { fetchPage } from './fetchPage.js';

export function auditSearchFilter(search) {
  return textContainsFilter(['actor_email', 'action', 'table_name'], search);
}

export async function fetchAuditPage(client, { page = 1, pageSize = 25, search = '' } = {}) {
  const size = [25, 50, 100].includes(pageSize) ? pageSize : 25;
  return fetchPage(() => {
    let query = client.from('audit_log')
    .select('id, actor_email, action, table_name, row_id, created_at', { count: 'exact' })
    .order('created_at', { ascending: false }).order('id', { ascending: false });
    const filter = auditSearchFilter(search);
    if (filter) query = query.or(filter);
    return query;
  }, { page, pageSize: size });
}
