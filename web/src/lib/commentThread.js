// Turning a flat list of comments into a thread.
//
// The database stores one level (0110): a comment, and replies pointing at it. This assembles that
// into what the screen draws — parents oldest-first, each carrying its replies oldest-first,
// because a conversation reads downwards and jumping the newest reply above the question it
// answers makes the thread unreadable.
//
// Pure, so it can be tested. TaskDetail imports Supabase through its hooks and cannot be.

const time = (row) => {
  const t = Date.parse(row?.created_at ?? '');
  return Number.isNaN(t) ? 0 : t;
};

/**
 * Group a flat list into [{ ...comment, replies: [...] }].
 *
 * A reply whose parent is not in the list is promoted to top level rather than dropped. That
 * happens when a parent was deleted between two fetches, and losing the answer as well would look
 * like data loss to the person who wrote it.
 */
export function buildThread(rows = []) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const tops = [];
  const repliesFor = new Map();

  for (const row of rows) {
    const isReply = row.parent_id && byId.has(row.parent_id);
    if (isReply) {
      if (!repliesFor.has(row.parent_id)) repliesFor.set(row.parent_id, []);
      repliesFor.get(row.parent_id).push(row);
    } else {
      tops.push(row);
    }
  }

  return tops
    .sort((a, b) => time(a) - time(b))
    .map((top) => ({
      ...top,
      replies: (repliesFor.get(top.id) ?? []).sort((a, b) => time(a) - time(b)),
    }));
}

/** Everything in the thread, replies included — for the count on the card. */
export function totalComments(rows = []) {
  return rows.length;
}

/**
 * Who to address when answering.
 *
 * Answering a reply keeps the conversation on the same thread (0110 flattens it), so the person
 * being answered would otherwise be lost. Instagram solves this by seeding the box with their
 * name; this returns the handle to seed it with.
 */
export function mentionFor(comment) {
  const name = comment?.author?.full_name?.trim();
  if (!name) return '';
  // First name only: a thread of "@Ramesh Kumar Nair" three times over is mostly punctuation.
  return `@${name.split(/\s+/)[0]} `;
}

/**
 * The label on the disclosure under a comment.
 *
 * Instagram hides replies behind a count rather than showing them all, because the reply is
 * usually the least interesting line in the thread until you are looking for it.
 */
export function replyToggleLabel(count, expanded) {
  if (count <= 0) return '';
  if (expanded) return count === 1 ? 'Hide reply' : 'Hide replies';
  return count === 1 ? 'View 1 reply' : `View ${count} replies`;
}
