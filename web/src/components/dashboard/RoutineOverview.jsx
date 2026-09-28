import { ListChecks } from 'lucide-react';
import { usePermissions } from '../../auth/usePermissions';
import { useRoutineStats } from '../../data/routines';
import { summarizeRoutineStats } from '../../lib/routines';
import { employeeRoutineStatus } from '../../lib/routineStatus';
import { useIstToday } from '../../lib/useIstToday';
import { Widget } from './shared';
import { SkeletonRows } from '../ui/Skeleton';

export default function RoutineOverview({ onNavigate }) {
  const { canBeyondSelf, viewingAsEmployee } = usePermissions();
  const today = useIstToday();
  const enabled = !viewingAsEmployee && canBeyondSelf('task.read');
  const query = useRoutineStats(today, today, { enabled });
  const progress = summarizeRoutineStats(query.data);
  const people = employeeRoutineStatus(query.data);
  const finished = people.filter(person => person.status === 'Completed').length;
  const inProgress = people.filter(person => person.status === 'In progress').length;
  const openTeam = () => onNavigate?.(`tasks/routine?routineView=team&routineSection=daily&routineDate=${today}`);
  if (!enabled || (!query.isLoading && !query.error && !progress.scheduled)) return null;
  return <Widget title="Team routines today" icon={ListChecks}
    action="Routine overview" onAction={openTeam}>
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
        {people.length > 0 && <>
          <p className="text-xs text-neutral-600 dark:text-neutral-300">
            {finished} employees completed · {inProgress} in progress · {people.length - finished - inProgress} not started
          </p>
          <ul aria-label="Employee routine status" className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {people.slice(0, 5).map(person => <li key={person.employeeId} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{person.employee?.full_name || person.employee?.employee_code || 'Employee'}</p>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{person.completed} of {person.scheduled} jobs completed</p>
              </div>
              <span className={`shrink-0 rounded-full px-2 py-1 text-xs font-medium ${person.status === 'Completed'
                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                : 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200'}`}>{person.status}</span>
            </li>)}
          </ul>
          <button type="button" onClick={openTeam} className="text-xs font-semibold text-brand-action hover:underline">
            View all {people.length} employee statuses
          </button>
        </>}
      </div>}
  </Widget>;
}
