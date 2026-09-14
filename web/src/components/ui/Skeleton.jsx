// Loading placeholders that occupy the same space as the real content.
//
// A centred spinner tells you "something is happening" but collapses the layout, so the page
// jumps when data lands. A skeleton keeps the shape, which reads as faster even at identical
// speed. The shimmer is disabled under prefers-reduced-motion (see index.css).
import React from 'react';
import './skeleton.css';

export function Skeleton({ className = '', style, as: Component = 'div' }) {
  return <Component className={`skeleton ${className}`} style={style} aria-hidden="true" />;
}

/** Rows for a list/table screen. */
export function SkeletonRows({ rows = 6, className = '', compact = false, avatar = true, trailing = true, label = 'Loading' }) {
  return (
    <div className={`${compact ? 'skeleton-rows-compact' : 'space-y-2'} ${className}`} role="status" aria-label={label}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className={`${compact ? 'skeleton-list-row' : 'premium-card'} flex items-center gap-3`} aria-hidden="true">
          {avatar && <Skeleton className="w-9 h-9 rounded-xl shrink-0" />}
          <div className="flex-1 space-y-2 min-w-0">
            <Skeleton className={`h-3 ${i % 2 ? 'w-1/2' : 'w-1/3'}`} />
            <Skeleton className={`h-2.5 ${i % 2 ? 'w-2/3' : 'w-1/2'}`} />
          </div>
          {trailing && <Skeleton className="h-6 w-12 sm:w-16 rounded-lg shrink-0" />}
        </div>
      ))}
      <span className="sr-only">{label}…</span>
    </div>
  );
}

/** Tiles for a KPI strip. */
export function SkeletonCards({ count = 4, className = '', label = 'Loading' }) {
  return (
    <div className={`grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-4 ${className}`} role="status" aria-label={label}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="premium-card space-y-3" aria-hidden="true">
          <Skeleton className="h-2.5 w-2/3" />
          <Skeleton className="h-5 w-1/3" />
        </div>
      ))}
      <span className="sr-only">{label}…</span>
    </div>
  );
}

function TablePlaceholder({ rows, columns }) {
  return <div className="skeleton-table" aria-hidden="true" style={{ '--skeleton-columns': columns, '--skeleton-mobile-columns': Math.min(columns, 3) }}>
    <div className="skeleton-table-row skeleton-table-head">
      {Array.from({ length: columns }, (_, i) => <Skeleton key={i} className="h-2.5 w-2/3 max-w-24" />)}
    </div>
    {Array.from({ length: rows }, (_, row) => <div key={row} className="skeleton-table-row">
      {Array.from({ length: columns }, (_, col) => <Skeleton key={col} className={`h-3 ${col === 0 ? 'w-4/5' : (row + col) % 2 ? 'w-1/2' : 'w-2/3'}`} />)}
    </div>)}
  </div>;
}

/** A responsive table body, mounted where the loaded table would appear. */
export function SkeletonTable({ rows = 6, columns = 4, className = '', label = 'Loading' }) {
  return <div className={`min-w-0 ${className}`} role="status" aria-label={label}>
    <TablePlaceholder rows={rows} columns={columns} />
    <span className="sr-only">{label}…</span>
  </div>;
}

export function SkeletonForm({ fields = 6, className = '', label = 'Loading' }) {
  return <div className={`grid grid-cols-1 sm:grid-cols-2 gap-5 ${className}`} role="status" aria-label={label}>
    {Array.from({ length: fields }, (_, i) => <div key={i} className="space-y-2" aria-hidden="true">
      <Skeleton className="h-2.5 w-24" />
      <Skeleton className="h-10 w-full rounded-xl" />
    </div>)}
    <span className="sr-only">{label}…</span>
  </div>;
}

/** Keeps the heading, summary and content footprint while a route module loads. */
export function SkeletonPage({ className = '', label = 'Loading page' }) {
  return <div className={`page-shell space-y-6 ${className}`} role="status" aria-label={label}>
    <div className="flex items-center justify-between gap-4" aria-hidden="true">
      <div className="flex-1 space-y-3"><Skeleton className="h-6 w-40 max-w-full" /><Skeleton className="h-3 w-64 max-w-full" /></div>
      <Skeleton className="h-9 w-24 rounded-xl shrink-0" />
    </div>
    <div className="grid grid-cols-2 xl:grid-cols-4 gap-3" aria-hidden="true">
      {Array.from({ length: 4 }, (_, i) => <div key={i} className="premium-card space-y-4">
        <Skeleton className="h-2.5 w-2/3" /><Skeleton className="h-7 w-16" />
      </div>)}
    </div>
    <div className="premium-card p-0 overflow-hidden" aria-hidden="true"><TablePlaceholder rows={7} columns={4} /></div>
    <span className="sr-only">{label}…</span>
  </div>;
}

/** Anonymous shapes reserve app chrome while the session and access resolve. */
export function SkeletonApp() {
  return <div className="flex min-h-dvh bg-neutral-50 dark:bg-charcoal-900" role="status" aria-label="Loading workspace">
    <aside className="hidden lg:flex w-64 shrink-0 flex-col gap-8 border-r border-[var(--surface-border)] p-6" aria-hidden="true">
      <Skeleton className="h-9 w-36" />
      <div className="space-y-5">{Array.from({ length: 8 }, (_, i) => <div key={i} className="flex items-center gap-3">
        <Skeleton className="h-5 w-5 shrink-0" /><Skeleton className={`h-3 ${i % 2 ? 'w-24' : 'w-32'}`} />
      </div>)}</div>
    </aside>
    <div className="min-w-0 flex-1" aria-hidden="true">
      <div className="flex h-16 items-center justify-between gap-4 border-b border-[var(--surface-border)] px-5 sm:px-8">
        <Skeleton className="h-4 w-28" /><div className="flex items-center gap-4"><Skeleton className="hidden sm:block h-8 w-48" /><Skeleton className="h-9 w-9 rounded-full" /></div>
      </div>
      <SkeletonPage className="px-[var(--space-shell)] py-6 sm:py-8" />
    </div>
    <span className="sr-only">Loading workspace…</span>
  </div>;
}
