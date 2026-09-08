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
