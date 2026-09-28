import { useState } from 'react';
import { Undo2 } from 'lucide-react';
import { routineEditStartDate } from '../lib/routineSchedule';
import { routineScheduleLabel } from '../lib/routines';
import FormSection from './ui/FormSection';

const INPUT = 'w-full min-h-11 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 px-3 py-2 text-sm text-neutral-800 dark:text-neutral-200';
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '')
  && Number.isFinite(Date.parse(`${value}T12:00:00Z`))
  && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;

/** Resume the saved definition through the same history-preserving RPC used by routine edits. */
export default function RestoreRoutineDialog({ routine, today, busy = false, error, onRestore, onClose }) {
  const suggestedStart = routineEditStartDate(routine, today);
  const [startDate, setStartDate] = useState(suggestedStart);
  const [endDate, setEndDate] = useState(routine.end_date >= suggestedStart ? routine.end_date : '');
  const jobs = (routine.jobs ?? []).filter((job) => job.is_active !== false);
  const once = routine.frequency === 'once';
  const allowed = routine.can_manage === true && Boolean(routine.retired_on) && !routine.replaced_by;
  const valid = allowed && jobs.length > 0 && jobs.length <= 100 && validDate(startDate) && startDate >= today
    && (once || !endDate || (validDate(endDate) && endDate >= startDate));

  return <FormSection title="Restore routine" icon={Undo2}
    subtitle="Choose when this retired routine resumes. Earlier completion history is preserved."
    submitLabel="Restore routine" busyLabel="Restoring…" busy={busy} error={error} disabled={!valid}
    onClose={busy ? undefined : onClose}
    onSubmit={async (event) => {
      event.preventDefault();
      if (!valid || busy) return;
      await onRestore({ id: routine.id, title: routine.title, detail: routine.detail,
        jobs: jobs.map((job, index) => ({ id: job.id, title: job.title, detail: job.detail, sort_order: index })),
        schedule: { frequency: routine.frequency, start_date: startDate,
          end_date: once ? startDate : endDate || null,
          weekdays: routine.weekdays ?? [], month_day: routine.month_day ?? null, interval_days: routine.interval_days ?? null },
      });
    }}>
    <fieldset disabled={busy} className="space-y-4">
      <div className="rounded-xl bg-neutral-50 dark:bg-neutral-950 p-3 text-sm">
        <p className="font-semibold">{routine.title}</p>
        <p className="mt-1 text-neutral-500">Assigned to {routine.employee?.full_name ?? 'this employee'} · {routineScheduleLabel(routine)} · {jobs.length} job{jobs.length === 1 ? '' : 's'}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm"><span>Restore from</span><input required type="date" className={INPUT}
          min={today} value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
        {!once && <label className="space-y-1 text-sm"><span>End date (optional)</span><input type="date" className={INPUT}
          min={startDate || today} value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label>}
      </div>
      {routine.frequency === 'interval' && <p className="text-xs text-neutral-500">The suggested date keeps the existing repeat schedule. Choosing another date restarts the interval from that date.</p>}
      <p className="text-xs text-neutral-500">The same employee and jobs will be restored. Completed jobs keep their history. Deleted jobs remain available in the routine editor.</p>
      {jobs.length === 0 && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">This routine has no active jobs. Use Edit routine to add or restore a job first.</p>}
    </fieldset>
  </FormSection>;
}
