import { ListChecks } from 'lucide-react';
import { usePermissions } from '../../auth/usePermissions';
import { useRoutineStats } from '../../data/routines';
import { summarizeRoutineStats } from '../../lib/routines';
import { useIstToday } from '../../lib/useIstToday';
import { Widget } from './shared';
import { SkeletonRows } from '../ui/Skeleton';

export default function RoutineOverview({ onNavigate }) {
  const { canBeyondSelf, viewingAsEmployee } = usePermissions();
  const today = useIstToday();
  const enabled = !viewingAsEmployee && canBeyondSelf('task.read');
  const query = useRoutineStats(today, today, { enabled });
  const progress = summarizeRoutineStats(query.data);
  if (!enabled || (!query.isLoading && !query.error && !progress.scheduled)) return null;
  return <Widget title="Team routines today" icon={ListChecks}
    action="Routine overview" onAction={() => onNavigate?.('tasks/routine?routineView=team')}>
    {query.isLoading ? <SkeletonRows rows={2} avatar={false} label="Loading routine completion" />
      : query.error ? <div role="alert" className="home-work-error">
        <p>Could not load routine completion. {query.error.message}</p>
        <button type="button" onClick={() => query.refetch()}>Try again</button>
      </div> : <div className="space-y-3">
        <p className="text-sm"><strong>{progress.completed} of {progress.scheduled}</strong> scheduled jobs completed · {progress.pct}%</p>
        <div role="progressbar" aria-label="Team routine job completion" aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={progress.pct} className="h-2 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
          <div className="h-full rounded-full bg-brand" style={{ width: `${progress.pct}%` }} />
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{progress.pending} jobs remaining today across your visible team.</p>
      </div>}
  </Widget>;
}
