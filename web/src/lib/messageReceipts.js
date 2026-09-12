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
