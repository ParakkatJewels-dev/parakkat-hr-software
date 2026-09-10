// For rosters, reference lists and period-bounded reports, not unbounded event/message history.
// Each factory must return
// a fresh RLS-scoped query with a deterministic order ending in a unique id.
// Advance by rows received: the server may impose a smaller cap than the requested page size.
export async function fetchCollection(makeQuery, { pageSize = 500 } = {}) {
  const size = Math.max(1, Math.min(1000, Math.floor(Number(pageSize)) || 500));
  const rows = [];
  const ids = new Set();
  for (;;) {
    const { data, error } = await makeQuery().range(rows.length, rows.length + size - 1);
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('Could not load the complete list. Please refresh.');
    if (!data.length) return rows;
    for (const row of data) {
      if (row.id == null || ids.has(row.id)) {
        throw new Error('The list changed while loading. Please refresh to load a complete list.');
      }
      ids.add(row.id);
      rows.push(row);
    }
  }
}
