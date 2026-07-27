// Loading placeholders that occupy the same space as the real content.
//
// A centred spinner tells you "something is happening" but collapses the layout, so the page
// jumps when data lands. A skeleton keeps the shape, which reads as faster even at identical
// speed. The shimmer is disabled under prefers-reduced-motion (see index.css).
import React from 'react';

export function Skeleton({ className = '' }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

/** Rows for a list/table screen. */
export function SkeletonRows({ rows = 6, className = '' }) {
  return (
    <div className={`space-y-2 ${className}`} role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="premium-card flex items-center gap-3">
          <Skeleton className="w-9 h-9 rounded-xl shrink-0" />
          <div className="flex-1 space-y-2 min-w-0">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-2.5 w-1/2" />
          </div>
          <Skeleton className="h-6 w-16 rounded-lg shrink-0" />
        </div>
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}

/** Tiles for a KPI strip. */
export function SkeletonCards({ count = 4 }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-4" role="status" aria-label="Loading">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="premium-card space-y-3">
          <Skeleton className="h-2.5 w-2/3" />
          <Skeleton className="h-5 w-1/3" />
        </div>
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}
