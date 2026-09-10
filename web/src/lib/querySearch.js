// Columns must be a code-owned allow-list, never user input. Quoting prevents punctuation
// from becoming a PostgREST filter expression; escaping makes LIKE wildcards literal.
export function textContainsFilter(columns, search) {
  const text = String(search ?? '').trim().slice(0, 200);
  if (!text) return '';
  const pattern = `%${text.replace(/[\\%_]/g, '\\$&')}%`;
  const quoted = `"${pattern.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return columns.map((column) => `${column}.ilike.${quoted}`).join(',');
}
