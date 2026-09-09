// Turning a Postgres refusal into a sentence.
//
// RLS speaks in its own voice — "new row violates row-level security policy for table \"tasks\"" —
// and that string was going straight onto the screen of somebody in an HR office who has no idea
// what a row-level security policy is, and no way to tell a permission problem from a broken app.
//
// Only messages we can honestly explain are translated. Anything unrecognised is passed through
// unchanged: a wrong-but-confident translation is worse than a technical one, because it sends the
// reader looking in the wrong place.
const RULES = [
  {
    // 42501 / "violates row-level security policy". The write was understood and refused.
    match: /row-level security policy/i,
    say: (table) =>
      table === 'tasks'
        ? 'You can\'t move that task to somebody outside the part of the organisation you manage.'
        : 'You don\'t have permission to make that change.',
  },
  {
    match: /duplicate key value|already exists/i,
    say: () => 'That already exists.',
  },
  {
    match: /violates foreign key constraint/i,
    say: () => 'Something this refers to no longer exists. Refresh and try again.',
  },
  {
    match: /violates not-null constraint/i,
    say: () => 'A required field was left empty.',
  },
  {
    match: /violates check constraint/i,
    say: () => 'That value isn\'t allowed here.',
  },
  {
    match: /JWT expired|invalid claim|not authenticated/i,
    say: () => 'Your session has expired. Sign in again.',
  },
  {
    match: /Failed to fetch|NetworkError|fetch failed/i,
    say: () => 'Couldn\'t reach the server. Check your connection and try again.',
  },
];

/**
 * @param error   anything thrown by a Supabase call (or a plain Error)
 * @param table   the table being written, when the caller knows it — lets the RLS message name the
 *                actual problem instead of shrugging
 */
export function humanDbError(error, table) {
  // No error is not an error. Call sites pass this straight to a panel's `error` prop, and a
  // truthy string here would paint a failure banner on a form nobody has submitted yet.
  if (!error) return null;
  const raw = typeof error === 'string' ? error : error?.message;
  if (!raw) return 'Something went wrong.';
  for (const rule of RULES) {
    if (rule.match.test(raw)) return rule.say(table);
  }
  return raw;
}
