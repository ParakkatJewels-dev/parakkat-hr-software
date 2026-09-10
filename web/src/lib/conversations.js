// Naming a conversation, reading its state, and laying a thread out.
//
// Pure, so it can be tested. The screen reaches Supabase through its hooks and cannot be.

/**
 * The key that makes a one-to-one conversation unique between two people.
 *
 * Sorted, so it is the same string whichever of the two presses "message" first. Without that, two
 * colleagues acting at the same moment open two separate threads and neither contains the other's
 * replies — and because both look correct to their owner, it is the kind of bug that gets reported
 * as "he never answered me".
 *
 * Must match the value written by the client in data/messages.js; the unique index in 0115 is what
 * actually enforces it.
 */
export function directKey(a, b) {
  if (!a || !b) return null;
  return [a, b].sort().join(':');
}

/** Everyone in the conversation who is not you. */
export function others(conversation, myEmployeeId) {
  return (conversation?.members ?? []).filter((m) => m.employee_id !== myEmployeeId);
}

/**
 * What to call this conversation on screen.
 *
 * A group has a name. A direct conversation is named by the other person — and when there is no
 * other person it says so rather than rendering blank: a conversation with yourself is what you get
 * from a note-to-self, and an empty group is what is left after everybody leaves.
 */
export function conversationName(conversation, myEmployeeId, { unknown = 'Unknown' } = {}) {
  if (conversation?.kind === 'group') {
    const title = conversation.title?.trim();
    if (title) return title;
    // An unnamed group is named by who is in it, which is what people would have called it anyway.
    const names = others(conversation, myEmployeeId)
      .map((m) => m.employee?.full_name)
      .filter(Boolean);
    if (names.length === 0) return 'Group';
    if (names.length <= 3) return names.join(', ');
    return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
  }

  const them = others(conversation, myEmployeeId)[0];
  if (!them) return 'Just you';
  return them.employee?.full_name || unknown;
}

/** The words under the name in the list. */
export function previewOf(conversation, myEmployeeId) {
  if (conversation?.last_deleted) return 'Message deleted';

  const kind = conversation?.last_kind;
  const media =
    kind === 'image' ? 'Photo'
    : kind === 'video' ? 'Video'
    : kind === 'voice' ? 'Voice note'
    : kind === 'file' ? 'File'
    : null;

  const text = media ?? conversation?.last_body?.trim();
  if (!text) return 'No messages yet';

  // "You:" only in a group, where it disambiguates. In a one-to-one it is noise on half the lines.
  const mine = conversation?.last_sender_id && conversation.last_sender_id === myEmployeeId;
  return mine && conversation?.kind === 'group' ? `You: ${text}` : text;
}

/** Most recently active first — the only order a conversation list is ever wanted in. */
export function sortConversations(list = []) {
  return [...(list ?? [])].sort((a, b) =>
    String(b?.last_message_at ?? '').localeCompare(String(a?.last_message_at ?? ''))
  );
}

/** The number on the badge. Deliberately a sum of rows, so a muted conversation could opt out later. */
export function unreadTotal(list = []) {
  return (list ?? []).reduce((sum, c) => sum + (Number(c?.unread_count) || 0), 0);
}

/**
 * A thread, split into days.
 *
 * Returns [{ day, messages }] oldest first, which is the order a conversation is read in. The day
 * is the ISO date so the caller decides how to word it — "Today" needs to know what today is, and
 * that is not something a pure function should reach for.
 */
export function groupByDay(messages = []) {
  const out = [];
  for (const m of messages ?? []) {
    if (!m?.created_at) continue;
    const day = String(m.created_at).slice(0, 10);
    const last = out[out.length - 1];
    if (last && last.day === day) last.messages.push(m);
    else out.push({ day, messages: [m] });
  }
  return out;
}

/**
 * Should this message show its sender's name and avatar?
 *
 * No, when the person above it is the same person and spoke within two minutes — a run of five
 * messages from one person is one thought, and repeating their name five times turns it into five.
 * Always in a group and never in a one-to-one, where there is only one other person it could be.
 */
export function showsSender(message, previous, { kind = 'direct', windowMs = 120000 } = {}) {
  if (kind !== 'group') return false;
  if (!previous || previous.sender_id !== message?.sender_id) return true;
  const gap = new Date(message.created_at) - new Date(previous.created_at);
  return !(gap >= 0 && gap < windowMs);
}

/** Mine sits on the right, everybody else's on the left. */
export const isMine = (message, myEmployeeId) =>
  Boolean(myEmployeeId) && message?.sender_id === myEmployeeId;

/**
 * Is there anything here this person has not seen?
 *
 * Read from the counted column rather than from the loaded messages: the list shows twenty
 * conversations and loads the messages of none of them.
 */
export const hasUnread = (conversation) => (Number(conversation?.unread_count) || 0) > 0;

/**
 * Where a media object lives.
 *
 * `<conversation_id>/<something unique>.<ext>` — the conversation id FIRST, because 0115's storage
 * policies read it back out of the path with storage.foldername() to decide who may fetch the
 * object. Change this shape and those policies stop matching.
 */
export function mediaPath(conversationId, fileName) {
  const clean = String(fileName ?? 'file')
    // Anything that is not a word character, a dot or a dash becomes an underscore — separators
    // included, so nothing the user names a file can add a folder to this path.
    .replace(/[^\w.-]+/g, '_')
    // Then collapse runs of dots. Slashes are already gone by here, so '..' cannot traverse
    // anything — but a stored path containing '..' is a thing every future reader has to stop and
    // reason about, and it costs one line to make sure it never appears.
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+/, '')
    .slice(-80) || 'file';
  return `${conversationId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${clean}`;
}
