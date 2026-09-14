import { fetchCollection } from './fetchCollection.js';

export const chatPreferencesKey = (userId, employeeId) => ['chat-preferences', userId ?? null, employeeId ?? null];

export function fetchChatPreferences(client) {
  return fetchCollection(() => client.from('chat_preferences')
    .select('conversation_id,is_pinned,is_favourite').order('conversation_id'),
  { key: (row) => row.conversation_id });
}

/** Only supplied boolean flags are sent. The server resolves the employee from authentication. */
export async function setChatPreference(client, { conversationId, isPinned, isFavourite } = {}) {
  if (typeof conversationId !== 'string' || !conversationId.trim()) throw new Error('Choose a conversation.');
  if (isPinned === undefined && isFavourite === undefined) throw new Error('Choose a chat preference to update.');
  const parameters = { _conversation_id: conversationId };
  for (const [key, value] of [['_is_pinned', isPinned], ['_is_favourite', isFavourite]]) {
    if (value === undefined) continue;
    if (typeof value !== 'boolean') throw new Error('Chat preferences must be true or false.');
    parameters[key] = value;
  }
  const { data, error } = await client.rpc('set_chat_preference', parameters);
  if (error) throw error;
  const saved = data?.[0];
  if (data?.length !== 1 || saved?.conversation_id !== conversationId
    || typeof saved.is_pinned !== 'boolean' || typeof saved.is_favourite !== 'boolean') {
    throw new Error('Could not confirm the chat preference. Please refresh and try again.');
  }
  return saved;
}

export function applyChatPreference(rows = [], saved) {
  return [...rows.filter((row) => row.conversation_id !== saved.conversation_id), saved]
    .sort((a, b) => a.conversation_id.localeCompare(b.conversation_id));
}
