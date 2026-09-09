// Telling "the migration has not been run" apart from "something went wrong".
//
// WHY THIS EXISTS
// A migration and the client that uses it ship separately here — the database is migrated by hand
// and the client by a deploy — so there is always a window where one is ahead of the other. That
// window has now broken this app twice in ways that looked nothing like the cause: threading added
// `parent_id` to the comments SELECT, and PostgREST rejects the WHOLE query when one column in it
// is unknown, so a feature nobody had turned on yet took the entire comment thread with it.
//
// The rule that follows: a client may ASK for something a pending migration provides, but it must
// not fall over when the answer is "no such column". Reading degrades to the old shape; writing
// degrades to the old behaviour. The feature is quietly absent until the migration lands, instead
// of the surrounding screen being broken until then.
//
// This is deliberately narrow. It matches only the schema-cache and undefined-column errors, so a
// genuine failure — a permission refusal, a network error, a constraint — still surfaces as
// itself rather than being swallowed as "not migrated yet".

/** Postgres 42703 (undefined_column) / 42P01 (undefined_table), and PostgREST's schema cache miss. */
export function isMissingSchema(error) {
  if (!error) return false;
  const code = String(error.code ?? '');
  if (code === '42703' || code === '42P01' || code === 'PGRST204' || code === 'PGRST205') return true;
  const text = `${error.message ?? ''} ${error.details ?? ''} ${error.hint ?? ''}`;
  return /does not exist|could not find the .* column|schema cache/i.test(text);
}

/**
 * Run `attempt`; if it fails only because the schema is behind, run `fallback` instead.
 *
 * Both are functions returning a promise. Anything that is not a missing-schema error is rethrown
 * untouched — the point is to survive a pending migration, not to hide real failures.
 */
export async function withSchemaFallback(attempt, fallback) {
  try {
    return await attempt();
  } catch (error) {
    if (!isMissingSchema(error)) throw error;
    return fallback(error);
  }
}
