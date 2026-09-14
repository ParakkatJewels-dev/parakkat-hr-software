import React from 'react';
import { Skeleton } from './ui/Skeleton';
import { TaskListColumns } from './TaskListRow';

export function TaskListSkeleton({ rows = 5 }) {
  return (
    <div className="work-list" role="status" aria-label="Loading tasks">
      <div aria-hidden="true"><TaskListColumns /></div>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="work-row" aria-hidden="true">
          <div className="work-row-grid">
            <div className="work-row-content">
              <Skeleton className="h-5 w-5 rounded shrink-0" />
              <div className="work-row-copy space-y-3">
                <Skeleton className={index % 2 ? 'h-4 w-2/3' : 'h-4 w-4/5'} />
                <Skeleton className="h-3 w-1/2" />
                <Skeleton className="h-2.5 w-1/3" />
              </div>
            </div>
            <div className="work-row-person"><Skeleton className="h-6 w-6 rounded-full shrink-0" /><Skeleton className="h-3 w-20" /></div>
            <div className="work-row-date"><Skeleton className="h-3 w-20" /></div>
            <div className="work-status"><Skeleton className="h-6 w-24 rounded" /></div>
            <div className="work-expand"><Skeleton className="h-5 w-5 rounded" /></div>
          </div>
        </div>
      ))}
    </div>
  );
}
