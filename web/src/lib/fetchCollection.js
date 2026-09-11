// For rosters, reference lists and period-bounded reports, not unbounded event/message history.
// Each factory must return
// a fresh RLS-scoped query with a deterministic order ending in a unique id.
// Advance by rows received: the server may impose a smaller cap than the requested page size.
// Re-read the previous boundary row on each page. A deletion ahead of an offset would otherwise
// skip an unseen row without producing a duplicate. This detects moving boundaries; independent
// HTTP requests do not provide a database snapshot of concurrent edits.
export async function fetchCollection(makeQuery, { pageSize = 500, key = (row) => row.id } = {}) {
  const size = Math.max(1, Math.min(1000, Math.floor(Number(pageSize)) || 500));
  const rows = [];
  const ids = new Set();
  const changed = () => new Error('The list changed while loading. Please refresh to load a complete list.');
  const read = async (from, to) => {
    const { data, error } = await makeQuery().range(from, to);
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('Could not load the complete list. Please refresh.');
    return data;
  };
  for (;;) {
    const boundary = rows.length ? rows.length - 1 : null;
    let data = await read(boundary ?? 0, rows.length + size - 1);
    if (boundary !== null) {
      const previous = key(rows[boundary]);
      if (!data.length || key(data[0]) !== previous) throw changed();
      data = data.slice(1);
      if (!data.length) {
        // A server cap of one returns only the overlap even when more rows exist. Probe the
        // next offset and recheck the boundary afterwards before accepting that continuation.
        data = await read(rows.length, rows.length + size - 1);
        const verify = await read(boundary, boundary);
        if (verify.length !== 1 || key(verify[0]) !== previous) throw changed();
      }
    }
    if (!data.length) return rows;
    for (const row of data) {
      const id = key(row);
      if (id == null || ids.has(id)) {
        throw changed();
      }
      ids.add(id);
      rows.push(row);
    }
  }
}

// A 500-person UUID filter can exceed proxy URL limits. Split the filter, then page each result;
// grouping related rows is not equivalent to limiting them (one task may have many comments).
export async function fetchInCollection(makeQuery, values, options = {}) {
  const unique = [...new Set((values ?? []).filter((value) => value != null))];
  const rows = [];
  for (let offset = 0; offset < unique.length; offset += 100) {
    const batch = unique.slice(offset, offset + 100);
    rows.push(...await fetchCollection(() => makeQuery(batch), options));
  }
  return rows;
}
