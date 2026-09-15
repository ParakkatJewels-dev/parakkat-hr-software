// Preserve Postgres microseconds when comparing a receipt with a message in the same millisecond.
function timestampMicros(value) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const fraction = String(value).match(/T\d{2}:\d{2}:\d{2}\.(\d+)/)?.[1] ?? '';
  return milliseconds * 1000 + Number(fraction.padEnd(6, '0').slice(3, 6));
}

export function receiptCoversMessage(member, message, kind = 'read') {
  const received = timestampMicros(member?.[`last_${kind}_at`]);
  const sent = timestampMicros(message?.created_at);
  if (received === null || sent === null) return false;
  if (received !== sent) return received > sent;
  const cursor = member?.[`last_${kind}_message_id`];
  // Existing reading positions predate cursor IDs and cover their whole timestamp.
  return !cursor || (Boolean(message?.id) && String(cursor) >= String(message.id));
}

export function messageDeliveryStatus(message, conversation) {
  const sent = timestampMicros(message?.created_at);
  const recipients = (conversation?.members ?? []).filter((member) => {
    if (member.employee_id === message?.sender_id) return false;
    const joined = timestampMicros(member.joined_at);
    return joined === null || sent === null || joined <= sent;
  });
  if (!recipients.length) return 'sent';
  const accepted = !conversation?.request_status || conversation.request_status === 'accepted';
  if (accepted && recipients.every((member) => receiptCoversMessage(member, message, 'read'))) return 'seen';
  if (recipients.every((member) => receiptCoversMessage(member, message, 'delivered'))) return 'delivered';
  return 'sent';
}

/** Apply a server receipt event immediately, without losing names or moving a cursor backwards. */
export function mergeConversationReceipts(data, receipt) {
  if (!receipt?.conversation_id || !receipt.employee_id) return data;
  const conversations = Array.isArray(data) ? data : data?.conversations;
  if (!Array.isArray(conversations)) return data;
  let changed = false;
  const next = conversations.map((conversation) => {
    if (conversation.id !== receipt.conversation_id) return conversation;
    let memberChanged = false;
    const members = conversation.members?.map((member) => {
      if (member.employee_id !== receipt.employee_id) return member;
      let nextMember = member;
      for (const kind of ['delivered', 'read']) {
        const at = `last_${kind}_at`, id = `last_${kind}_message_id`;
        if (timestampMicros(receipt[at]) === null) continue;
        if (timestampMicros(member[at]) !== null && !receiptCoversMessage(receipt, {
          created_at: member[at], id: member[id],
        }, kind)) continue;
        if (member[at] === receipt[at] && member[id] === receipt[id]) continue;
        nextMember = { ...nextMember, [at]: receipt[at], [id]: receipt[id] ?? null };
      }
      memberChanged ||= nextMember !== member;
      return nextMember;
    });
    if (!memberChanged) return conversation;
    changed = true;
    return { ...conversation, members };
  });
  if (!changed) return data;
  return Array.isArray(data) ? next : { ...data, conversations: next };
}
