export const CHAT_SEARCH_PAGE_SIZE = 30;

export async function fetchChatSearchPage(client, conversationId, query, cursor = null) {
  const text = String(query ?? '').trim().slice(0, 4000);
  if (!conversationId || !text) return { messages: [], nextCursor: null };
  const { data, error } = await client.rpc('search_chat_messages', {
    _conversation_id: conversationId, _query: text,
    _before_at: cursor?.created_at ?? null, _before_id: cursor?.id ?? null,
    _limit: CHAT_SEARCH_PAGE_SIZE + 1,
  });
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error('Search could not be loaded. Please try again.');
  const messages = data.slice(0, CHAT_SEARCH_PAGE_SIZE);
  const last = messages.at(-1);
  return { messages, nextCursor: data.length > CHAT_SEARCH_PAGE_SIZE && last
    ? { created_at: last.created_at, id: last.id } : null };
}
