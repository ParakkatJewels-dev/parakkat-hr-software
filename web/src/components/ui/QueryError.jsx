import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { humanDbError } from '../../lib/dbErrors';
import Btn from './Btn';

/** Keep failed reads distinct from empty results, and retry without reloading the page. */
export default function QueryError({ error, title = 'This could not be loaded.', onRetry, retrying = false,
  hasData = false, className = '' }) {
  if (!error) return null;
  return <div className={`rounded-xl border border-amber-300 bg-amber-50 p-3 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200 ${className}`}>
    <div className="flex items-start gap-2" role="alert">
      <AlertTriangle size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 space-y-1 text-sm">
        <p className="font-semibold">{title}</p>
        <p className="break-words">{humanDbError(error)}</p>
        {hasData && <p>Showing the last available data. It may be out of date.</p>}
      </div>
    </div>
    {onRetry && <Btn className="mt-3" icon={RefreshCw} busy={retrying} onClick={() => {
      if (!retrying) Promise.resolve().then(onRetry).catch(() => {});
    }}>{retrying ? 'Retrying…' : 'Try again'}</Btn>}
  </div>;
}
