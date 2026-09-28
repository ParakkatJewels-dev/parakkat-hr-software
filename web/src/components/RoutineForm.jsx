import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, CheckSquare, Plus, Trash2, Undo2 } from 'lucide-react';
import { routineEditStartDate } from '../lib/routineSchedule';
import FormSection from './ui/FormSection';
import { btnClass } from './ui/Btn';
import RoutinePeoplePicker from './RoutinePeoplePicker';
import QueryError from './ui/QueryError';
import { SkeletonRows } from './ui/Skeleton';
import Pagination, { usePagination } from './ui/Pagination';

const INPUT = 'w-full min-h-11 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 px-3 py-2 text-sm text-neutral-800 dark:text-neutral-200';
const WEEKDAYS = [[1, 'Monday'], [2, 'Tuesday'], [3, 'Wednesday'], [4, 'Thursday'], [5, 'Friday'], [6, 'Saturday'], [7, 'Sunday']];

/** A routine's jobs share one schedule; the server preserves earlier completion history. */
export default function RoutineForm({ initial, employees = [], employeesLoading = false, employeesError, onRetryEmployees,
  today, onSave, onClose, busy, error }) {
  const editing = Boolean(initial?.id);
  const resuming = Boolean(initial?.resume);
  const existingSchedule = initial?.schedule ?? initial ?? {};
  const firstDate = today;
  const [title, setTitle] = useState(initial?.title ?? '');
  const [detail, setDetail] = useState(initial?.detail ?? '');
  const [employeeIds, setEmployeeIds] = useState(initial?.employee_id ? [initial.employee_id] : []);
  const [jobs, setJobs] = useState(() => {
    const activeJobs = initial?.jobs?.filter((job) => job.is_active !== false) ?? [];
    const listed = activeJobs.length ? [...activeJobs] : [{ title: '', detail: '' }];
    if (initial?.addJob && activeJobs.length && activeJobs.length < 100) listed.push({ title: '', detail: '' });
    return listed.map((job, index) => ({ key: `job-${index}`, id: job.id, title: job.title ?? '', detail: job.detail ?? '' }));
  });
  const [deletedJobs, setDeletedJobs] = useState(() => (initial?.jobs ?? [])
    .filter((job) => job.is_active === false && job.deleted_at)
    .map((job) => ({ key: `deleted-${job.id}`, id: job.id, title: job.title ?? '', detail: job.detail ?? '' })));
  const deletedPager = usePagination(deletedJobs, 10);
  const nextJob = useRef(jobs.length);
  const [schedule, setSchedule] = useState({ frequency: existingSchedule.frequency ?? 'daily',
    start_date: routineEditStartDate(existingSchedule, today),
    end_date: existingSchedule.end_date && existingSchedule.end_date >= firstDate ? existingSchedule.end_date : '',
    weekdays: existingSchedule.weekdays?.length ? existingSchedule.weekdays : [1],
    month_day: existingSchedule.month_day ?? Number(today.slice(-2)), interval_days: existingSchedule.interval_days ?? 2 });
  const updateJob = (index, field, value) => setJobs((previous) => previous.map((job, position) => position === index ? { ...job, [field]: value } : job));
  const moveJob = (index, offset) => setJobs((previous) => {
    const next = [...previous];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    return next;
  });
  const deleteJob = (index) => {
    const job = jobs[index];
    if (jobs.length <= 1) return;
    setJobs((previous) => previous.filter((_, position) => position !== index));
    if (job.id || job.title.trim() || job.detail.trim()) setDeletedJobs((previous) => [...previous, job]);
  };
  const restoreJob = (job) => {
    if (jobs.length >= 100) return;
    setJobs((previous) => [...previous, job]);
    setDeletedJobs((previous) => previous.filter((item) => item.key !== job.key));
  };
  const validSchedule = schedule.start_date && schedule.start_date >= firstDate
    && (schedule.frequency === 'once' || !schedule.end_date || schedule.end_date >= schedule.start_date)
    && (schedule.frequency !== 'weekly' || schedule.weekdays.length > 0)
    && (schedule.frequency !== 'monthly' || (Number.isInteger(Number(schedule.month_day)) && Number(schedule.month_day) >= 1 && Number(schedule.month_day) <= 31))
    && (schedule.frequency !== 'interval' || (Number.isInteger(Number(schedule.interval_days)) && Number(schedule.interval_days) >= 1 && Number(schedule.interval_days) <= 366));
  const validEmployees = editing || (!employeesLoading && !employeesError && employeeIds.every(id => employees.some(person => person.id === id)));
  const valid = title.trim() && jobs.length > 0 && jobs.length <= 100 && jobs.every((job) => job.title.trim())
    && employeeIds.length > 0 && employeeIds.length <= 1000 && validEmployees && validSchedule;
  return <FormSection focusHeading title={editing ? 'Edit routine' : 'Create routine'}
    subtitle={resuming ? 'Edit the jobs and choose a start date. Saving resumes this routine from that date; earlier completion history is preserved.'
      : editing ? 'Add jobs or change dates; earlier completion history is preserved.' : 'Create one routine with as many jobs as needed, then choose its schedule and employees.'}
    icon={CheckSquare} onClose={busy ? undefined : onClose} busy={busy} error={error} disabled={!valid}
    submitLabel={editing ? 'Save routine' : `Assign routine${employeeIds.length ? ` to ${employeeIds.length} employee${employeeIds.length === 1 ? '' : 's'}` : ''}`}
    onSubmit={async (event) => {
      event.preventDefault();
      if (!valid || busy) return;
      const payload = { title: title.trim(), detail: detail.trim(), jobs: jobs.map((job, index) => ({ ...(editing && job.id ? { id: job.id } : {}), title: job.title.trim(), detail: job.detail.trim(), sort_order: index })),
        schedule: { ...schedule, end_date: schedule.frequency === 'once' ? schedule.start_date : schedule.end_date || null, month_day: Number(schedule.month_day), interval_days: Number(schedule.interval_days) } };
      if (editing) payload.id = initial.id;
      else payload.employeeIds = employeeIds;
      try { await onSave(payload); } catch { /* The mutation's error stays beside the form. */ }
    }}>
    <fieldset className="routine-form-fields space-y-5" disabled={busy}>
      <section className="routine-form-section space-y-3" aria-label="Routine details">
      <h3 className="text-base font-bold">Routine details</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 text-sm font-medium"><span>Routine name</span><input required maxLength={120} className={INPUT} value={title}
          onChange={(event) => setTitle(event.target.value)} placeholder="For example, opening checks" /></label>
        <label className="space-y-1 text-sm font-medium"><span>Routine description (optional)</span><input maxLength={4000} className={INPUT} value={detail}
          onChange={(event) => setDetail(event.target.value)} placeholder="What this routine is for" /></label>
      </div>
      </section>
      <section className="routine-form-section space-y-3" aria-label="Jobs in this routine">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-bold">Jobs in this routine</h3>
          <span className="text-xs text-neutral-500">{jobs.length} job{jobs.length === 1 ? '' : 's'}</span></div>
        <p className="text-xs text-neutral-500">Use Add job to extend this checklist. You do not need a separate routine for each job.</p>
        <ol className="space-y-3">{jobs.map((job, index) => <li key={job.key} className="space-y-3 rounded-xl border border-neutral-200 dark:border-neutral-800 p-3">
          <div className="flex items-center justify-between gap-2"><span className="text-xs font-semibold text-neutral-500">Job {index + 1}</span>
            <div className="flex gap-1">
              <button type="button" className={btnClass('ghost')} disabled={index === 0} aria-label={`Move job ${index + 1} up`} onClick={() => moveJob(index, -1)}><ArrowUp size={15} /></button>
              <button type="button" className={btnClass('ghost')} disabled={index === jobs.length - 1} aria-label={`Move job ${index + 1} down`} onClick={() => moveJob(index, 1)}><ArrowDown size={15} /></button>
              <button type="button" className={btnClass('ghost')} disabled={jobs.length === 1} aria-label={`${job.id ? 'Delete' : 'Remove'} job ${index + 1}`} onClick={() => deleteJob(index)}><Trash2 size={15} /></button>
            </div></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm"><span>Job {index + 1} name</span><input required maxLength={200} className={INPUT} value={job.title} onChange={(event) => updateJob(index, 'title', event.target.value)} placeholder="Check the opening stock" /></label>
            <label className="space-y-1 text-sm"><span>Job {index + 1} instructions (optional)</span><input maxLength={4000} className={INPUT} value={job.detail} onChange={(event) => updateJob(index, 'detail', event.target.value)} placeholder="Include any details the employee needs" /></label>
          </div>
        </li>)}</ol>
        <button type="button" className={btnClass('ghost')} disabled={jobs.length >= 100} onClick={() => setJobs((previous) => [...previous, { key: `job-${nextJob.current++}`, title: '', detail: '' }])}><Plus size={16} />Add job</button>
        {editing && <p className="text-xs text-neutral-500">Delete a job to remove it from this checklist from the selected date. You can restore deleted jobs here. Save routine to apply your changes. Keep at least one job, or retire the routine to stop all jobs.</p>}
        {deletedJobs.length > 0 && <section className="space-y-3 rounded-xl border border-neutral-200 dark:border-neutral-800 p-3" aria-label="Deleted jobs">
          <h4 className="text-sm font-semibold">Deleted jobs ({deletedJobs.length})</h4>
          <p className="text-xs text-neutral-500">Restore a job to add it back from the selected date. Earlier completion history stays unchanged.</p>
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">{deletedPager.slice.map((job) => <li key={job.key} className="flex flex-wrap items-start justify-between gap-3 py-3">
            <div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{job.title || 'Untitled job'}</p>
              {job.detail && <p className="mt-1 break-words text-xs text-neutral-500">{job.detail}</p>}</div>
            <button type="button" className={btnClass('ghost')} disabled={jobs.length >= 100} aria-label={`Restore job ${job.title || 'Untitled job'}`} onClick={() => restoreJob(job)}><Undo2 size={15} />Restore job</button>
          </li>)}</ul>
          <Pagination {...deletedPager} noun="deleted jobs" sizes={[10, 25, 50]} />
          {jobs.length >= 100 && <p className="text-xs text-neutral-500">A routine can contain up to 100 active jobs. Delete a job before restoring another.</p>}
        </section>}
      </section>
      <section className="routine-form-section space-y-3" aria-label="Routine schedule">
        <h3 className="text-sm font-bold">Schedule</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1 text-sm"><span>Frequency</span><select className={INPUT} value={schedule.frequency} onChange={(event) => setSchedule({ ...schedule, frequency: event.target.value })}>
            <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="interval">Every N days</option><option value="once">Once</option>
          </select></label>
          <label className="space-y-1 text-sm"><span>{editing ? 'Changes start on' : schedule.frequency === 'once' ? 'Due date' : 'Start date'}</span><input required type="date" min={firstDate} className={INPUT} value={schedule.start_date}
            onChange={(event) => setSchedule({ ...schedule, start_date: event.target.value })} /></label>
          {schedule.frequency !== 'once' && <label className="space-y-1 text-sm"><span>End date (optional)</span><input type="date" min={schedule.start_date || firstDate} className={INPUT} value={schedule.end_date}
            onChange={(event) => setSchedule({ ...schedule, end_date: event.target.value })} /></label>}
        </div>
        {schedule.frequency === 'weekly' && <fieldset><legend className="mb-2 text-sm font-medium">Due on</legend><div className="flex flex-wrap gap-2">{WEEKDAYS.map(([day, label]) => <label key={day}
          className={`flex min-h-11 items-center gap-2 rounded-xl border px-3 py-2 text-sm ${schedule.weekdays.includes(day) ? 'border-brand bg-brand-soft text-brand-ink' : 'border-neutral-200 dark:border-neutral-800'}`}>
          <input type="checkbox" checked={schedule.weekdays.includes(day)} onChange={(event) => setSchedule({ ...schedule,
            weekdays: event.target.checked ? [...schedule.weekdays, day].sort((a, b) => a - b) : schedule.weekdays.filter((value) => value !== day) })} />{label}</label>)}</div></fieldset>}
        {schedule.frequency === 'monthly' && <div className="max-w-sm space-y-1"><label className="space-y-1 text-sm"><span>Day of month</span><input required type="number" min={1} max={31} step={1} className={INPUT}
          value={schedule.month_day} onChange={(event) => setSchedule({ ...schedule, month_day: event.target.value })} /></label><p className="text-xs text-neutral-500">Shorter months use their last day.</p></div>}
        {schedule.frequency === 'interval' && <label className="block max-w-sm space-y-1 text-sm"><span>Repeat every (days)</span><input required type="number" min={1} max={366} step={1} className={INPUT}
          value={schedule.interval_days} onChange={(event) => setSchedule({ ...schedule, interval_days: event.target.value })} /><span className="block text-xs text-neutral-500">Counted from the start date.{editing ? ' The suggested date keeps the existing repeat schedule; choosing another date changes it.' : ''}</span></label>}
        <p className="text-xs text-neutral-500">Every job in this routine follows this schedule. Completion is recorded separately for each due date.</p>
        {editing && <p className="text-xs text-neutral-500">Jobs already completed today stay checked when you add jobs. To remove or change a completed job, choose tomorrow or a later date.</p>}
      </section>
      {editing ? <div className="rounded-xl bg-neutral-50 dark:bg-neutral-950 p-3 text-sm"><p className="font-semibold">Assigned to {initial.employee?.full_name ?? 'this employee'}</p>
        <p className="mt-1 text-xs text-neutral-500">These changes apply to this employee’s routine. Other employees keep their existing routines.</p></div>
        : <div className="routine-form-section space-y-3">
          <QueryError error={employeesError} title="Employees could not be loaded." onRetry={onRetryEmployees} />
          {employeesLoading ? <SkeletonRows rows={3} compact label="Loading employees for routine assignment" />
            : !employeesError && <>
              {!validEmployees && employeeIds.length > 0 && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">Some selected employees are no longer available. Clear the selection and choose employees again.</p>}
              <RoutinePeoplePicker employees={employees} selectedIds={employeeIds} onChange={setEmployeeIds} disabled={busy} />
            </>}
        </div>}
    </fieldset>
  </FormSection>;
}
