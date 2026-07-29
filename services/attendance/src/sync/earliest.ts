// The date of the oldest transaction Easy Time Pro actually holds.
//
// "All time" is whatever the terminal has, not a number we pick. Guessing a year too early means
// fifty pointless requests against an on-prem box; a year too late silently loses history and
// nobody notices until somebody queries a date that is missing.
//
// Asked for by ordering the transaction list ascending and reading the first row. Field and query
// names move between BioTime builds, so several spellings are tried and an unhelpful build simply
// returns null rather than failing the caller.
import { biotime } from '../biotime/client';

interface RawTxn { punch_time?: string }

export async function earliestPunchDate(): Promise<string | null> {
  for (const ordering of ['punch_time', 'id', 'punch_time,id']) {
    try {
      const body = await biotime.get<{ data?: RawTxn[]; results?: RawTxn[] }>(
        '/iclock/api/transactions/',
        { page: 1, page_size: 1, ordering }
      );
      const first = (body?.data ?? body?.results ?? [])[0];
      if (first?.punch_time) return String(first.punch_time).slice(0, 10);
    } catch {
      // This build may reject `ordering`; try the next spelling.
    }
  }
  return null;
}
