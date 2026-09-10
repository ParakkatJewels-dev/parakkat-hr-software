// The three decisions a pager makes, separated from the control that draws it.
//
// They live here because they are the part that can be wrong in a way nobody sees. A pager that
// renders one page too few does not look broken — the list simply ends, and the rows past the end
// are indistinguishable from rows that do not exist. That is exactly what happened: the "does
// everything fit on one page" test compared the row count against the SMALLEST OFFERED page size
// rather than the one in use, which was the same number while every caller took the default 25 and
// stopped being the same the moment one asked for ten. A fifteen-row list drew ten rows and no
// control.
//
// Pagination.jsx imports React and cannot be loaded by the test runner. These can.

/**
 * Should the pager be drawn at all?
 *
 * Only when there is a second page. Against `pageSize` — the size actually in use — and never
 * against the list of offered sizes, which says nothing about how this list is currently paged.
 */
export function shouldShowPager(count, pageSize) {
  if (!Number.isFinite(count) || !Number.isFinite(pageSize) || pageSize <= 0) return false;
  return count > pageSize;
}

/**
 * The sizes to offer, always including the one in use.
 *
 * A select whose value matches no option is drawn by browsers as the first option, so a list paged
 * at eight rendered a control reading 25 over it.
 */
export function pageSizeOptions(pageSize, sizes = [25, 50, 100, 200]) {
  const list = (sizes ?? []).filter((n) => Number.isFinite(n) && n > 0);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return [...new Set(list)].sort((a, b) => a - b);
  return [...new Set(list.includes(pageSize) ? list : [pageSize, ...list])].sort((a, b) => a - b);
}

/**
 * Page numbers to show: always first and last, a window around the current page, ellipses between.
 *
 * Seven or fewer pages are all shown — an ellipsis that hides one number is worse than the number.
 */
export function pageWindow(current, total) {
  if (!Number.isFinite(total) || total < 1) return [];
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

  const page = Math.min(Math.max(1, current || 1), total);
  const out = [1];
  const from = Math.max(2, page - 1);
  const to = Math.min(total - 1, page + 1);
  if (from > 2) out.push('…');
  for (let n = from; n <= to; n++) out.push(n);
  if (to < total - 1) out.push('…');
  out.push(total);
  return out;
}

// Derive the visible window synchronously: a filter or deletion must not paint an empty old page.
export function paginationWindow(count, requestedPage = 1, requestedSize = 25) {
  const pageSize = Number.isFinite(Number(requestedSize)) && Number(requestedSize) > 0
    ? Math.max(1, Math.floor(Number(requestedSize))) : 25;
  const total = Math.max(0, Number(count) || 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(totalPages, Math.max(1, Math.floor(Number(requestedPage)) || 1));
  return { page, pageSize, totalPages, count: total,
    from: total ? (page - 1) * pageSize + 1 : 0,
    to: Math.min(page * pageSize, total) };
}
