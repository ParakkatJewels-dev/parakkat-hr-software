// Quote PostgREST values so punctuation cannot create another filter expression.
export function auditSearchFilter(search) {
  const text = String(search ?? '').trim().slice(0, 200);
  if (!text) return '';
  const pattern = `%${text.replace(/[\\%_]/g, '\\$&')}%`;
  const quoted = `"${pattern.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return ['actor_email', 'action', 'table_name'].map((column) => `${column}.ilike.${quoted}`).join(',');
}

export async function fetchAuditPage(client, { page = 1, pageSize = 25, search = '' } = {}) {
  const size = [25, 50, 100].includes(pageSize) ? pageSize : 25;
  const offset = (Math.max(1, Math.floor(Number(page)) || 1) - 1) * size;
  let query = client.from('audit_log')
    .select('id, actor_email, action, table_name, row_id, created_at', { count: 'exact' })
    .order('created_at', { ascending: false }).order('id', { ascending: false });
  const filter = auditSearchFilter(search);
  if (filter) query = query.or(filter);
  const { data, count, error } = await query.range(offset, offset + size - 1);
  if (error) throw error;
  return { rows: data ?? [], count: count ?? 0 };
}
