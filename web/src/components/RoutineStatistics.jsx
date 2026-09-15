import { useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { filterRoutineStats, summarizeRoutineStats } from '../lib/routines';
import { addDays, startOfMonth } from '../lib/dateRange';
import { humanDbError } from '../lib/dbErrors';
import Pagination, { usePagination } from './ui/Pagination';
import { SkeletonRows } from './ui/Skeleton';
import { btnClass } from './ui/Btn';

const INPUT = 'w-full min-h-11 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 px-3 py-2 text-sm text-neutral-800 dark:text-neutral-200';
const frequencies = [['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['interval', 'Every N days'], ['once', 'Once']];
const options = (rows, key, getName) => [...new Map(rows.filter((row) => row.employee?.[key])
  .map((row) => [row.employee[key], getName(row.employee) || 'Unnamed'])).entries()].sort((a, b) => a[1].localeCompare(b[1]));

export default function RoutineStatistics({ rows = [], from, to, today, onRangeChange, isLoading, error, onRetry, invalidRange }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [frequency, setFrequency] = useState('');
  const [designationId, setDesignationId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [routineId, setRoutineId] = useState('');
  const filtered = useMemo(() => filterRoutineStats(rows, { query, status, frequency, designationId, departmentId, branchId, routineId }),
    [rows, query, status, frequency, designationId, departmentId, branchId, routineId]);
  const total = summarizeRoutineStats(filtered);
  const pager = usePagination(filtered, 25, null, `${from}:${to}:${query}:${status}:${frequency}:${designationId}:${departmentId}:${branchId}:${routineId}`);
  const routines = [...new Map(rows.map((row) => [row.routine_id, `${row.routine_name} · ${row.employee?.full_name ?? 'Employee'}`])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  const historyDates = filtered.map((row) => row.history_start_date).filter((date) => date && from < date).sort();
  return <section className="space-y-4" aria-label="Routine completion statistics">
    <div><h2 className="text-base font-bold">Routine statistics</h2><p className="mt-1 text-sm text-neutral-500">Compare completed jobs with the dates they were due. Future dates are excluded.</p></div>
    <div className="premium-card space-y-4">
      <div className="flex flex-wrap gap-2" aria-label="Statistics period presets">{[
        ['Today', today], ['Last 7 days', addDays(today, -6)], ['This month', startOfMonth(today)], ['Last 30 days', addDays(today, -29)],
      ].map(([label, start]) => <button key={label} type="button" className={btnClass(from === start && to === today ? 'primary' : 'ghost')}
        aria-pressed={from === start && to === today} onClick={() => onRangeChange({ from: start, to: today })}>{label}</button>)}</div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <label className="space-y-1 text-sm"><span>Statistics from</span><input type="date" required className={INPUT} max={to || today} value={from} onChange={(event) => onRangeChange({ from: event.target.value, to })} /></label>
        <label className="space-y-1 text-sm"><span>Statistics to</span><input type="date" required className={INPUT} min={from} max={today} value={to} onChange={(event) => onRangeChange({ from, to: event.target.value })} /></label>
        <label className="space-y-1 text-sm"><span>Search employee or routine</span><input type="search" className={INPUT} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, code or routine" /></label>
        <label className="space-y-1 text-sm"><span>Completion</span><select className={INPUT} value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All progress</option><option value="owing">Incomplete</option><option value="finished">Complete</option></select></label>
        <label className="space-y-1 text-sm"><span>Routine</span><select className={INPUT} value={routineId} onChange={(event) => setRoutineId(event.target.value)}><option value="">All routines</option>{routines.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <label className="space-y-1 text-sm"><span>Frequency</span><select className={INPUT} value={frequency} onChange={(event) => setFrequency(event.target.value)}><option value="">All frequencies</option>{frequencies.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <label className="space-y-1 text-sm"><span>Designation</span><select className={INPUT} value={designationId} onChange={(event) => setDesignationId(event.target.value)}><option value="">All designations</option>{options(rows, 'designation_id', (employee) => employee.designation?.title).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <label className="space-y-1 text-sm"><span>Department</span><select className={INPUT} value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}><option value="">All departments</option>{options(rows, 'department_id', (employee) => employee.department?.name).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <label className="space-y-1 text-sm"><span>Branch</span><select className={INPUT} value={branchId} onChange={(event) => setBranchId(event.target.value)}><option value="">All branches</option>{options(rows, 'branch_id', (employee) => employee.branch?.code || employee.branch?.name).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      </div>
      <p className="text-xs text-neutral-500">Choose a period of up to 366 days. Each job counts once for each scheduled due date.</p>
      {invalidRange ? <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">{invalidRange}</p>
        : isLoading ? <SkeletonRows rows={5} avatar={false} label="Loading routine statistics" />
          : error ? <div role="alert" className="flex items-start gap-2 text-sm text-rose-700 dark:text-rose-300"><AlertTriangle size={16} className="shrink-0" /><span>{humanDbError(error)} <button type="button" className="underline" onClick={onRetry}>Retry statistics</button></span></div>
            : <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">{[
                ['Due jobs', total.scheduled], ['Completed jobs', total.completed], ['Missed jobs', total.missed], ['Pending today', total.pending], ['Completion rate', total.scheduled ? `${total.pct}%` : '—'],
              ].map(([label, value]) => <div key={label} className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-3"><p className="text-xs text-neutral-500">{label}</p><p className="mt-1 text-xl font-bold">{value}</p></div>)}</div>
              {(historyDates.length > 0 || total.unscored_done_jobs > 0) && <p className="rounded-xl bg-amber-50 dark:bg-amber-950/30 p-3 text-sm text-amber-800 dark:text-amber-200">
                {historyDates.length > 0 && 'Completion rates use each routine’s tracked schedule. Its tracking start date is shown below. '}
                {total.unscored_done_jobs > 0 && `Earlier saved job completions: ${total.unscored_done_jobs}. These are excluded from completion rates because their earlier schedules were not recorded.`}</p>}
              {filtered.length === 0 ? <p className="py-8 text-center text-sm text-neutral-500">No routine occurrences match this period and these filters.</p>
                : <div className="overflow-x-auto"><table className="premium-table w-full text-sm"><thead><tr>{['Employee', 'Routine', 'Due jobs', 'Completed jobs', 'Missed jobs', 'Pending today', 'Rate'].map((label) => <th key={label} className="text-left">{label}</th>)}</tr></thead>
                  <tbody>{pager.slice.map((row) => <tr key={row.id}><td data-label="Employee"><span className="block font-semibold">{row.employee?.full_name ?? 'Employee'}</span><span className="text-xs text-neutral-500">{[row.employee?.employee_code, row.employee?.designation?.title].filter(Boolean).join(' · ')}</span></td>
                    <td data-label="Routine"><span className="block font-semibold">{row.routine_name}</span><span className="text-xs text-neutral-500">{frequencies.find(([id]) => id === row.frequency)?.[1] ?? 'Daily'}</span>
                      {row.history_start_date && from < row.history_start_date && <span className="mt-1 block text-xs text-neutral-500">Schedule tracked from {row.history_start_date}</span>}
                      {Number(row.unscored_done_jobs) > 0 && <span className="mt-1 block text-xs text-neutral-500">{row.unscored_done_jobs} earlier saved jobs</span>}</td>
                    <td data-label="Due jobs">{row.scheduled}</td><td data-label="Completed jobs">{row.completed}</td><td data-label="Missed jobs">{row.missed}</td><td data-label="Pending today">{row.pending}</td>
                    <td data-label="Rate">{Number(row.scheduled) ? `${Math.round(Number(row.completed) / Number(row.scheduled) * 100)}%` : '—'}</td></tr>)}</tbody></table></div>}
              <div className="paged-collection"><Pagination {...pager} noun="routine summaries" sizes={[25, 50, 100]} /></div>
            </>}
    </div>
  </section>;
}
