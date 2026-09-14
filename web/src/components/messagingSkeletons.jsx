import React from 'react';
import { Skeleton } from './ui/Skeleton';
import './messagingSkeletons.css';

export function ConversationSkeleton({ rows = 6, compact = false, label = 'Loading conversations' }) {
  return (
    <div className="messaging-skeleton-list" data-compact={compact} role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="messaging-skeleton-person" aria-hidden="true">
          <Skeleton className="messaging-skeleton-avatar" />
          <div className="messaging-skeleton-copy">
            <Skeleton className={index % 2 ? 'h-3 w-1/2' : 'h-3 w-2/3'} />
            <Skeleton className={index % 2 ? 'h-2.5 w-3/4' : 'h-2.5 w-1/2'} />
          </div>
          {!compact && <Skeleton className="h-2 w-7 shrink-0 self-start mt-2" />}
        </div>
      ))}
    </div>
  );
}

export function MessageThreadSkeleton() {
  return (
    <div className="messaging-skeleton-thread" role="status" aria-label="Loading messages">
      <Skeleton className="h-5 w-20 rounded-full self-center mb-2" />
      {[false, false, true, false, true].map((own, index) => (
        <div key={index} className="messaging-skeleton-bubble" data-own={own} aria-hidden="true">
          {index === 0 && <Skeleton className="h-2.5 w-1/3" />}
          <Skeleton className="h-3 w-full" />
          {index % 2 === 0 && <Skeleton className="h-3 w-3/4" />}
          <Skeleton className="h-2 w-9 ml-auto mt-1" />
        </div>
      ))}
    </div>
  );
}

export function MessageMediaSkeleton({ kind = 'file', label = 'Loading attachment' }) {
  const visual = kind === 'image' || kind === 'video';
  return (
    <div className="messaging-skeleton-media" data-visual={visual} role="status" aria-label={label}>
      {visual ? <Skeleton className="messaging-skeleton-preview" /> : (
        <div className="flex items-center gap-3 w-full" aria-hidden="true">
          <Skeleton className="h-9 w-9 rounded-full shrink-0" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-2 w-1/3" />
          </div>
        </div>
      )}
    </div>
  );
}
