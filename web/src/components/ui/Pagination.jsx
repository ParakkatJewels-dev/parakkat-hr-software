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
import { btnClass } from './Btn';

/**
 * @param items      the full, already-filtered array
 * @param initialSize rows per page to start with
 * @returns { slice, page, setPage, totalPages, pageSize, setPageSize, count, from, to }
 */
export function usePagination(items, initialSize = 25) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialSize);

  const count = items.length;
  const totalPages = Math.max(1, Math.ceil(count / pageSize));

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

/** Page numbers to show: always first and last, a window around the current page, ellipses between. */
function pageWindow(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out = [1];
  const from = Math.max(2, current - 1);
  const to = Math.min(total - 1, current + 1);
  if (from > 2) out.push('…');
  for (let n = from; n <= to; n++) out.push(n);
  if (to < total - 1) out.push('…');
  out.push(total);
  return out;
}

const NUM =
  'pagination-number min-w-[2rem] sm:min-w-[1.75rem] px-2 sm:px-1.5 py-1.5 sm:py-1 rounded-md text-sm font-bold tabular-nums cursor-pointer transition-colors';

/**
 * Renders nothing when everything fits on one page — a pager under a five-row list is noise.
 * `noun` is used in the summary, e.g. "1–25 of 242 people".
 */
export default function Pagination({
  page, setPage, totalPages, pageSize, setPageSize, count, from, to,
  noun = 'rows', sizes = [25, 50, 100, 200], className = '',
}) {
  if (count <= Math.min(...sizes)) return null;

  return (
    <div className={`premium-card pagination-shell flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${className}`}>
      <span className="text-sm text-neutral-500 dark:text-neutral-400 tabular-nums text-center sm:text-left">
        <b className="text-neutral-800 dark:text-neutral-200">{from}–{to}</b> of {count} {noun}
      </span>

      <div className="pagination-pages flex items-center justify-center gap-1 flex-wrap">
        <button
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page === 1}
          aria-label="Previous page"
          className={btnClass('subtle', 'sm', true)}
        >
          <ArrowLeft size={12} />
        </button>

        {pageWindow(page, totalPages).map((n, i) =>
          n === '…' ? (
            <span key={`gap-${i}`} className="px-1 text-neutral-400 select-none">…</span>
          ) : (
            <button
              key={n}
              onClick={() => setPage(n)}
              aria-label={`Page ${n}`}
              aria-current={n === page ? 'page' : undefined}
              className={`${NUM} ${
                n === page
                  ? 'bg-[#0ea971] text-white'
                  : 'text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-charcoal-800'
              }`}
            >
              {n}
            </button>
          )
        )}

        <button
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={page === totalPages}
          aria-label="Next page"
          className={btnClass('subtle', 'sm', true)}
        >
          <ArrowRight size={12} />
        </button>
      </div>

      <label className="pagination-size flex items-center justify-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
        <span className="hidden sm:inline">Per page</span>
        <select
          value={pageSize}
          onChange={(e) => setPageSize(Number(e.target.value))}
          aria-label="Rows per page"
          className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-transparent px-1.5 py-1 text-sm font-bold cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0ea971]/50"
        >
          {sizes.map((n) => (
            <option key={n} value={n} className="bg-white dark:bg-black">{n}</option>
          ))}
        </select>
      </label>
    </div>
  );
}
