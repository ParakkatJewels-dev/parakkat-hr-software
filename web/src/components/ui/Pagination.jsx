// Pagination — the hook and the control.
//
// Extracted from the Directory rather than reinvented per screen. At 242 employees a payroll run
// is 242 payslips, a day of attendance is 242 rows, and leave requests only ever grow: every list
// in this app outgrows a single page, and each one solving it differently is how a UI ends up
// feeling like several products.
//
// Client-side by design, for now. Everything here already fetches its full (RLS-scoped) set, so
// slicing in the browser is honest at this size. Past a few thousand rows the right answer is
// range queries in Postgres — at which point `usePagination` is the seam to change.
import React, { useState, useMemo, useEffect } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { pageContaining } from '../../lib/focusRow';
import { shouldShowPager, pageSizeOptions, pageWindow } from '../../lib/pagination';

/**
 * @param items      the full, already-filtered array
 * @param initialSize rows per page to start with
 * @param focusId    a row to page to, when a notification deep-linked to it (see focusRow.js)
 * @returns { slice, page, setPage, totalPages, pageSize, setPageSize, count, from, to }
 */
export function usePagination(items, initialSize = 25, focusId = null) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialSize);

  const count = items.length;
  const totalPages = Math.max(1, Math.ceil(count / pageSize));

  // Sent here by a notification: land on the page that actually holds the row. Without this the
  // app navigates you to a list, scrolls to a row that is not rendered, and does nothing visible —
  // which reads as a broken link rather than as a row sitting on page 3.
  useEffect(() => {
    const target = pageContaining(items, focusId, pageSize);
    if (target) setPage(target);
  }, [focusId, items, pageSize]);

  // Filtering down to fewer pages while sitting on page 9 leaves you staring at an empty table.
  // Clamping rather than resetting to 1 keeps your place when the list only shifts slightly.
  useEffect(() => {
    setPage((p) => Math.min(p, Math.max(1, Math.ceil(count / pageSize))));
  }, [count, pageSize]);

  const slice = useMemo(
    () => items.slice((page - 1) * pageSize, page * pageSize),
    [items, page, pageSize]
  );

  return {
    slice, page, setPage, totalPages, pageSize, setPageSize, count,
    from: count === 0 ? 0 : (page - 1) * pageSize + 1,
    to: Math.min(page * pageSize, count),
  };
}

/**
 * Renders nothing when everything fits on one page — a pager under a five-row list is noise.
 * `noun` is used in the summary, e.g. "1–25 of 242 people".
 *
 * The "fits on one page" test is against `pageSize`, NOT the smallest offered size. Those were the
 * same number while every caller used the default 25, and stopped being the same the moment a
 * caller asked for ten to a page: the pager hid itself for any count up to 25, so a fifteen-row
 * list showed ten rows, no control, and no way to reach the other five. A list that silently ends
 * early is worse than one with no paging at all.
 */
export default function Pagination({
  page, setPage, totalPages, pageSize, setPageSize, count, from, to,
  noun = 'rows', sizes = [25, 50, 100, 200], className = '', keepVisible = false,
}) {
  // Task lists keep the size selector available, including after choosing a larger page size.
  if (!keepVisible && !shouldShowPager(count, pageSize)) return null;

  // The select shows the size actually in use. Without this a caller starting at 8 rendered a
  // dropdown whose value matched no option, which browsers draw as the first one — a control
  // saying 25 over a list of 8.
  const options = pageSizeOptions(pageSize, sizes);

  return (
    <nav className={`premium-card pagination-shell ${className}`} aria-label={`${noun} pagination`}>
      <div className="pagination-summary">
        <span className="pagination-range">
          <b>{from}–{to}</b>
          <span>of {count} {noun}</span>
        </span>
        <span className="pagination-page-label">Page {page} of {totalPages}</span>
      </div>

      <div className="pagination-pages" aria-label="Pages">
        <button
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page === 1}
          aria-label="Previous page"
          className="pagination-nav-button"
        >
          <ArrowLeft size={12} />
        </button>

        {pageWindow(page, totalPages).map((n, i) =>
          n === '…' ? (
            <span key={`gap-${i}`} className="pagination-ellipsis" aria-hidden="true">…</span>
          ) : (
            <button
              key={n}
              onClick={() => setPage(n)}
              aria-label={`Page ${n}`}
              aria-current={n === page ? 'page' : undefined}
              className="pagination-number"
            >
              {n}
            </button>
          )
        )}

        <button
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={page === totalPages}
          aria-label="Next page"
          className="pagination-nav-button"
        >
          <ArrowRight size={12} />
        </button>
      </div>

      <label className="pagination-size">
        <span>Per page</span>
        <select
          value={pageSize}
          onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
          aria-label="Rows per page"
        >
          {options.map((n) => (
            <option key={n} value={n} className="bg-white dark:bg-black">{n}</option>
          ))}
        </select>
      </label>
    </nav>
  );
}
