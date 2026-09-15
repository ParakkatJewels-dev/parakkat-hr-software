import { paginationWindow } from './pagination.js';

// Read one server page, including installations whose API row cap is smaller than
// the requested page size. The factory supplies exact count and a stable id order.
// Verify the previous boundary while refilling a capped response, so moving rows
// cannot silently leave a gap. Separate page visits are not a database snapshot.
export async function fetchPage(makeQuery, { page = 1, pageSize = 25 } = {}) {
  const size = Math.min(200, paginationWindow(0, 1, pageSize).pageSize);
  const requestedPage = Number.isFinite(Number(page)) ? Math.max(1, Math.floor(Number(page)) || 1) : 1;
  const offset = (requestedPage - 1) * size;
  const rows = [];
  const ids = new Set();
  let count;
  const changed = () => new Error('The list changed while loading. Please refresh.');
  const read = async (from, to) => {
    const result = await makeQuery().range(from, to);
    if (result.error) throw result.error;
    if (!Array.isArray(result.data) || !Number.isInteger(result.count) || result.count < 0) {
      throw new Error('Could not load this page. Please refresh.');
    }
    if (count !== undefined && count !== result.count) throw changed();
    count = result.count;
    return result.data;
  };
  const append = (data) => {
    for (const row of data) {
      if (row.id == null || ids.has(row.id)) throw changed();
      ids.add(row.id);
      rows.push(row);
    }
  };

  append(await read(offset, offset + size - 1));
  const expected = Math.min(size, Math.max(0, count - offset));
  if (rows.length > expected || (!rows.length && expected > 0)) throw changed();
  while (rows.length < expected) {
    const boundary = offset + rows.length - 1;
    const previousId = rows.at(-1).id;
    let data = await read(boundary, offset + size - 1);
    if (!data.length || data[0].id !== previousId) throw changed();
    data = data.slice(1);
    if (!data.length) {
      // With a cap of one, the overlap consumes the whole response. Fetch the
      // continuation separately and ensure its boundary did not move meanwhile.
      data = await read(offset + rows.length, offset + size - 1);
      const verify = await read(boundary, boundary);
      if (verify.length !== 1 || verify[0].id !== previousId) throw changed();
    }
    if (!data.length) throw changed();
    append(data);
    if (rows.length > expected) throw changed();
  }
  return { rows, count };
}
