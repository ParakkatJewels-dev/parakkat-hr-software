// A thread loads a bounded page from a stable (created_at, id) cursor. Fetching one extra row
// tells the UI whether earlier messages exist even when the server applies a smaller row cap.
export async function fetchMessagePage(client, conversationId, fields, cursor = null, pageSize = 200) {
  const size = Math.max(1, Math.min(500, Math.floor(Number(pageSize)) || 200));
  const rows = [];
  const ids = new Set();
  let before = cursor;
  const quote = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  while (rows.length <= size) {
    let query = client.from('messages').select(fields).eq('conversation_id', conversationId)
      .order('created_at', { ascending: false }).order('id', { ascending: false });
    if (before) {
      const time = quote(before.created_at);
      query = query.or(`created_at.lt.${time},and(created_at.eq.${time},id.lt.${quote(before.id)})`);
    }
    const { data, error } = await query.range(0, size - rows.length);
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('Messages could not be loaded. Please try again.');
    if (!data.length) break;
    for (const row of data) {
      if (!row.id || !row.created_at || ids.has(row.id)) {
        throw new Error('The conversation changed while loading. Please try again.');
      }
      ids.add(row.id);
      rows.push(row);
    }
    const last = data.at(-1);
    before = { created_at: last.created_at, id: last.id };
  }
  const messages = rows.slice(0, size);
  const last = messages.at(-1);
  return {
    messages,
    nextCursor: rows.length > size ? { created_at: last.created_at, id: last.id } : null,
  };
}

export function flattenMessagePages(pages = []) {
  const seen = new Set();
  return pages.flatMap((page) => page.messages).filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  }).reverse();
}
