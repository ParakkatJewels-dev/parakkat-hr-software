// Pagination — the hook and the control.
//
// Extracted from the Directory rather than reinvented per screen. At 242 employees a payroll run
// is 242 payslips, a day of attendance is 242 rows, and leave requests only ever grow: every list
// in this app outgrows a single page, and each one solving it differently is how a UI ends up
// feeling like several products.
//
// usePagination slices an already-filtered collection. The control also accepts server-side
// counts and page callbacks (for example the audit log) without loading the whole history.
import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { pageContaining } from '../../lib/focusRow';
import { shouldShowPager, pageSizeOptions, pageWindow, paginationWindow } from '../../lib/pagination';

/**
 * @param items      the full, already-filtered array
 * @param initialSize rows per page to start with
 * @param focusId    a row to page to, when a notification deep-linked to it (see focusRow.js)
 * @returns { slice, page, setPage, totalPages, pageSize, setPageSize, count, from, to }
 */
export function usePagination(items, initialSize = 25, focusId = null, resetKey = '') {
  const [position, setPosition] = useState({ key: resetKey, page: 1 });
  const [size, setSize] = useState(initialSize);
  const handledFocus = useRef(null);
  const window = paginationWindow(items.length, position.key === resetKey ? position.page : 1, size);
  const { page, pageSize, count } = window;
  const setPage = useCallback((next) => {
    setPosition((prev) => {
      const current = paginationWindow(count, prev.key === resetKey ? prev.page : 1, size).page;
      const value = paginationWindow(count, typeof next === 'function' ? next(current) : next, size).page;
      return prev.key === resetKey && prev.page === value ? prev : { key: resetKey, page: value };
    });
  }, [count, size, resetKey]);
  const setPageSize = useCallback((next) => {
    setSize((prev) => paginationWindow(0, 1, typeof next === 'function' ? next(prev) : next).pageSize);
    setPosition({ key: resetKey, page: 1 });
  }, [resetKey]);

  useEffect(() => {
    if (position.key !== resetKey || position.page !== page) setPosition({ key: resetKey, page });
  }, [position, resetKey, page]);

  // Sent here by a notification: land on the page that actually holds the row. Without this the
  // app navigates you to a list, scrolls to a row that is not rendered, and does nothing visible —
  // which reads as a broken link rather than as a row sitting on page 3.
  useEffect(() => {
    if (!focusId) { handledFocus.current = null; return; }
    const key = JSON.stringify([focusId, pageSize, resetKey]);
    if (handledFocus.current === key) return;
    const target = pageContaining(items, focusId, pageSize);
    if (target) { handledFocus.current = key; setPage(target); }
  }, [focusId, items, pageSize, setPage, resetKey]);

  // Filtering down to fewer pages while sitting on page 9 leaves you staring at an empty table.
  // Clamping rather than resetting to 1 keeps your place when the list only shifts slightly.
  const slice = useMemo(
    () => items.slice((page - 1) * pageSize, page * pageSize),
    [items, page, pageSize]
  );

  return {
    ...window, slice, setPage, setPageSize, initialPageSize: initialSize,
  };
}

/**
 * Renders nothing when everything fits on one page — a pager under a five-row list is noise.
 * `noun` is used in the summary, e.g. "1–25 of 242 people".
 *
 * Keep the control when a smaller offered size is available, so increasing the size never
 * removes the user's way back. Always offer the caller's initial and currently selected sizes.
 */
export default function Pagination({
  page, setPage, totalPages, pageSize, setPageSize, count, from, to,
  noun = 'rows', sizes = [25, 50, 100, 200], className = '', keepVisible = false,
  initialPageSize, disabled = false,
}) {
  // Task lists keep the size selector available, including after choosing a larger page size.
  const options = pageSizeOptions(pageSize, [...sizes, initialPageSize]);
  if (!keepVisible && !shouldShowPager(count, Math.min(...options))) return null;

  // The select shows the size actually in use. Without this a caller starting at 8 rendered a
  // dropdown whose value matched no option, which browsers draw as the first one — a control
  // saying 25 over a list of 8.

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
          disabled={disabled || page === 1}
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
              disabled={disabled}
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
          disabled={disabled || page === totalPages}
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
          disabled={disabled}
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
