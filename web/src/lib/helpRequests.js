// Which side of a help request you are on, and what that means.
//
// Pure, so it can be tested: the screen imports Supabase through its hooks and the test runner
// cannot load it. Same split as taskBoard.js / focusRow.js.

export const HELP_REQUEST_STATUSES = ['Pending', 'Accepted', 'Declined', 'Cancelled'];

/** Requests THIS person must answer: addressed to a department they run, still waiting. */
export function incomingRequests(requests, myDepartmentIds) {
  const mine = new Set(myDepartmentIds ?? []);
  return (requests ?? []).filter((r) => mine.has(r.to_department_id));
}

/** Requests this person raised: sent FROM a department they run. */
export function outgoingRequests(requests, myDepartmentIds) {
  const mine = new Set(myDepartmentIds ?? []);
  return (requests ?? []).filter((r) => mine.has(r.from_department_id) && !mine.has(r.to_department_id));
}

/**
 * How many are actually waiting on you.
 *
 * Only the incoming ones count. A request you RAISED is waiting on somebody else, and badging it
 * would tell a head they have work to do when what they have is work to wait for.
 */
export function pendingCount(requests, myDepartmentIds) {
  return incomingRequests(requests, myDepartmentIds).filter((r) => r.status === 'Pending').length;
}

/**
 * Did the deciding head take the suggestion, or pick somebody else?
 *
 * Worth saying on screen either way: "they gave it to who you asked for" and "they gave it to
 * someone else" are different answers, and the second one is the one a requester needs to notice.
 */
export function preferenceOutcome(request) {
  if (!request || request.status !== 'Accepted') return null;
  const preferred = request.preferred?.id ?? null;
  const assigned = request.assignee?.id ?? null;
  if (!preferred) return 'no-preference';
  return preferred === assigned ? 'honoured' : 'overridden';
}

/** Newest first, but anything still waiting for an answer floats above what is settled. */
export function sortRequests(requests) {
  return [...(requests ?? [])].sort((a, b) => {
    const openA = a.status === 'Pending' ? 0 : 1;
    const openB = b.status === 'Pending' ? 0 : 1;
    if (openA !== openB) return openA - openB;
    return String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
  });
}

/* ------------------------- the org-wide view, for an administrator -------------------------- */

/**
 * How long a request has been waiting, in whole days.
 *
 * Only Pending requests age. An accepted one stopped waiting the moment it was answered, and
 * showing "12 days" beside it would read as a complaint about work that is already underway.
 */
export function daysWaiting(request, now = new Date()) {
  if (request?.status !== 'Pending' || !request?.created_at) return 0;
  const created = new Date(request.created_at);
  if (Number.isNaN(created.getTime())) return 0;
  return Math.max(0, Math.floor((now - created) / 86_400_000));
}

/**
 * Requests nobody has answered, oldest first.
 *
 * Oldest first rather than newest: this is a queue an administrator is chasing, and the useful end
 * is the one that has been ignored longest. The board itself sorts the other way, because there
 * you are reading your own recent activity.
 */
export function stalledRequests(requests = [], { minDays = 0, now = new Date() } = {}) {
  return requests
    .filter((r) => r.status === 'Pending' && daysWaiting(r, now) >= minDays)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

/**
 * Who is asking whom, and how often — the flow between departments rather than the individual asks.
 *
 * One row per department pair, so a pair that trades work constantly shows up as one line with a
 * high count instead of thirty lines an administrator has to add up by eye. `pending` is what is
 * still unanswered in that direction, which is the number worth acting on.
 */
export function requestFlow(requests = []) {
  const pairs = new Map();
  for (const r of requests) {
    const from = r.from_department?.name ?? 'Unknown';
    const to = r.to_department?.name ?? 'Unknown';
    const key = `${from}\u0000${to}`;
    if (!pairs.has(key)) {
      pairs.set(key, { from, to, total: 0, pending: 0, accepted: 0, declined: 0 });
    }
    const row = pairs.get(key);
    row.total += 1;
    if (r.status === 'Pending') row.pending += 1;
    else if (r.status === 'Accepted') row.accepted += 1;
    else if (r.status === 'Declined') row.declined += 1;
  }
  // Busiest first, and within that the ones with something outstanding.
  return [...pairs.values()].sort((a, b) => b.pending - a.pending || b.total - a.total);
}

/** Headline counts for the org-wide card. */
export function requestTotals(requests = [], now = new Date()) {
  const pending = requests.filter((r) => r.status === 'Pending');
  return {
    total: requests.length,
    pending: pending.length,
    accepted: requests.filter((r) => r.status === 'Accepted').length,
    declined: requests.filter((r) => r.status === 'Declined').length,
    // A request sitting a week without an answer is the thing an administrator is looking for.
    stalled: pending.filter((r) => daysWaiting(r, now) >= 7).length,
  };
}
