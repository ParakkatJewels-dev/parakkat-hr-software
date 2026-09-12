export const isIncomingRequest = (conversation, me) => Boolean(me)
  && conversation?.kind === 'direct'
  && conversation.request_status === 'pending'
  && conversation.request_recipient_id === me;

export const hasRequestMessage = (conversation) => Boolean(conversation?.last_message_id || conversation?.last_kind);

export function belongsInChatSection(conversation, me, section) {
  if (isIncomingRequest(conversation, me)) return section === 'requests' && hasRequestMessage(conversation);
  if (section === 'requests') return false;
  return !(conversation?.request_status === 'declined' && conversation.request_recipient_id === me);
}

export function canSendToConversation(conversation, me) {
  if (conversation?.kind !== 'direct' || !conversation.request_status || conversation.request_status === 'accepted') return true;
  return conversation.request_status === 'pending' && conversation.created_by === me;
}
