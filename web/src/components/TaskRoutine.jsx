// Named routines contain jobs that share a schedule, with completion recorded on each due date.
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckSquare, Plus, Square, PenLine, Archive } from 'lucide-react';
import { useRoutineSets, useRoutineDay, useRoutineStats, useSetRoutineTick,
  useCreateRoutineSet, useReplaceRoutineSet, useRetireRoutineSet } from '../data/routines';
import { filterRoutineGroups, groupRoutineDay, routineScheduleLabel } from '../lib/routines';
import { addDays, startOfMonth } from '../lib/dateRange';
import { useIstToday } from '../lib/useIstToday';
import { humanDbError } from '../lib/dbErrors';
import { usePermissions } from '../auth/usePermissions';
import { useAuth } from '../auth/AuthContext';
import { btnClass } from './ui/Btn';
import Pagination, { usePagination } from './ui/Pagination';
import { SkeletonRows } from './ui/Skeleton';
import ConfirmDialog from './ui/ConfirmDialog';
import RoutineForm from './RoutineForm';
import RoutineStatistics from './RoutineStatistics';
import RoutineOrgFilters from './RoutineOrgFilters';

const INPUT = 'w-full min-h-11 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 px-3 py-2 text-sm text-neutral-800 dark:text-neutral-200';
const FREQUENCIES = [['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['interval', 'Every N days'], ['once', 'Once']];
const scopeOf = (employee) => ({ employeeId: employee?.id, entityId: employee?.entity_id,
  zoneId: employee?.zone_id, branchId: employee?.branch_id, deptId: employee?.department_id });
const lastScheduledDay = (routine) => [routine.end_date, routine.retired_on,
  routine.frequency === 'once' ? routine.start_date : null].filter(Boolean).sort()[0] ?? null;

export default function TaskRoutine({ employees = [], employeesLoading = false, employeesError, onRetryEmployees }) {
  const today = useIstToday();
  const { employee } = useAuth();
  const { canAny, can, canBeyondSelf, viewingAsEmployee } = usePermissions();
  const seesTeam = !viewingAsEmployee && canBeyondSelf('task.read');
  const canDefine = canAny('task.create');
  const [params, setParams] = useSearchParams();
  const requestedView = params.get('routineView');
  const defaultView = employee?.id ? 'mine' : seesTeam ? 'team' : 'manage';
  const view = requestedView === 'team' && seesTeam ? 'team' : requestedView === 'manage' && canDefine ? 'manage' : defaultView;
  const chooseView = (next) => setParams((previous) => { const copy = new URLSearchParams(previous); copy.set('routineView', next); return copy; }, { replace: true });
  const [dayOverride, setDayOverride] = useState(null);
  const day = dayOverride ?? today;
  const [range, setRange] = useState(() => ({ from: startOfMonth(today), to: today }));
  const invalidRange = !range.from || !range.to ? 'Choose both dates.'
    : range.from > range.to ? 'The start date must be on or before the end date.'
      : range.to > today ? 'Choose an end date on or before today.'
        : range.from < addDays(range.to, -365) ? 'Choose a period of up to 366 days.' : '';
  const [editing, setEditing] = useState(null);
  const [retiring, setRetiring] = useState(null);
  const [message, setMessage] = useState('');
  const [manageSearch, setManageSearch] = useState('');
  const [manageFrequency, setManageFrequency] = useState('');
  const [manageStatus, setManageStatus] = useState('active');
  const [manageOrg, setManageOrg] = useState({});
  const [teamSection, setTeamSection] = useState('statistics');
  const ownDay = useRoutineDay(day, { employeeId: employee?.id, enabled: Boolean(employee?.id) && view === 'mine' });
  const teamDay = useRoutineDay(day, { enabled: seesTeam && view === 'team' && teamSection === 'daily' });
  const stats = useRoutineStats(range.from, range.to, { enabled: seesTeam && view === 'team' && teamSection === 'statistics' && !invalidRange });
  const sets = useRoutineSets({ employeeId: seesTeam ? undefined : employee?.id, enabled: canDefine,
    includeRetired: manageStatus !== 'active' });
  const create = useCreateRoutineSet();
  const replace = useReplaceRoutineSet();
  const setTick = useSetRoutineTick();
  const retire = useRetireRoutineSet();
  const eligibleEmployees = employees.filter((person) => person.status === 'Active'
    && (!viewingAsEmployee || person.id === employee?.id) && can('task.create', scopeOf(person)));
  const visibleSets = (sets.data ?? []).filter((routine) => (seesTeam || routine.employee_id === employee?.id)
    && (!manageFrequency || routine.frequency === manageFrequency)
    && (!manageOrg.designationId || routine.employee?.designation_id === manageOrg.designationId)
    && (!manageOrg.departmentId || routine.employee?.department_id === manageOrg.departmentId)
    && (!manageOrg.branchId || routine.employee?.branch_id === manageOrg.branchId)
    && (manageStatus !== 'archived' || (lastScheduledDay(routine) && lastScheduledDay(routine) < today))
    && (!manageSearch.trim() || [routine.title, routine.employee?.full_name, routine.employee?.employee_code,
      routine.employee?.designation?.title].join(' ').toLocaleLowerCase().includes(manageSearch.trim().toLocaleLowerCase())));
  const managePager = usePagination(visibleSets, 25, null, `${manageSearch}:${manageFrequency}:${manageStatus}:${seesTeam}:${manageOrg.designationId}:${manageOrg.departmentId}:${manageOrg.branchId}`);
  const myRows = (ownDay.data ?? []).filter((item) => item.employee_id === employee?.id);
  const save = async (payload) => {
    if (editing?.id) await replace.mutateAsync(payload);
    else await create.mutateAsync(payload);
    setMessage(editing?.id ? 'Future changes saved. Earlier completion history is preserved.' : `Routine assigned to ${payload.employeeIds.length} employee${payload.employeeIds.length === 1 ? '' : 's'}.`);
    setEditing(null);
  };
  const beginEdit = (routine = {}) => { create.reset(); replace.reset(); setMessage(''); setEditing(routine); };
  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-bold text-neutral-900 dark:text-white">Routines</h2>
      <p className="mt-1 text-sm text-neutral-500">Scheduled jobs, grouped into routines. Completion stays with each due date.</p></div>
      {canDefine && !editing && <button type="button" className={btnClass('primary')} onClick={() => beginEdit()}><Plus size={16} />Create routine</button>}
    </div>
    <nav className="flex flex-wrap gap-2" aria-label="Routine views">
      {employee?.id && <button type="button" className={btnClass(view === 'mine' ? 'primary' : 'ghost')} aria-pressed={view === 'mine'} onClick={() => chooseView('mine')}>My routines</button>}
      {seesTeam && <button type="button" className={btnClass(view === 'team' ? 'primary' : 'ghost')} aria-pressed={view === 'team'} onClick={() => chooseView('team')}>Team overview</button>}
      {canDefine && <button type="button" className={btnClass(view === 'manage' ? 'primary' : 'ghost')} aria-pressed={view === 'manage'} onClick={() => chooseView('manage')}>Manage routines</button>}
    </nav>
    {message && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">{message}</p>}
    {setTick.error && <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">{humanDbError(setTick.error)}</p>}
    {editing && canDefine && <RoutineForm key={editing.id ?? 'new'} initial={editing.id ? editing : undefined} employees={eligibleEmployees} today={today}
      employeesLoading={employeesLoading} employeesError={employeesError} onRetryEmployees={onRetryEmployees}
      onSave={save} onClose={() => setEditing(null)} busy={create.isPending || replace.isPending} error={humanDbError(create.error || replace.error)} />}
    {view === 'team' && seesTeam && <nav className="flex flex-wrap gap-2" aria-label="Team routine view">
      <button type="button" className={btnClass(teamSection === 'statistics' ? 'primary' : 'ghost')} aria-pressed={teamSection === 'statistics'} onClick={() => setTeamSection('statistics')}>Statistics</button>
      <button type="button" className={btnClass(teamSection === 'daily' ? 'primary' : 'ghost')} aria-pressed={teamSection === 'daily'} onClick={() => setTeamSection('daily')}>Daily checklists</button>
    </nav>}
    {(view === 'mine' || (view === 'team' && teamSection === 'daily')) && <div className="flex flex-wrap items-end gap-3">
      <label className="space-y-1 text-sm"><span>Routine date</span><input type="date" required className={INPUT} value={day} onChange={(event) => setDayOverride(event.target.value || null)} /></label>
      <button type="button" className={btnClass('ghost')} onClick={() => setDayOverride(null)}>Today</button>
      <p className="pb-2 text-xs text-neutral-500">{day > today ? 'Upcoming jobs can be completed on their due date.' : day < today ? 'Past completions remain in history. Authorized managers can correct them.' : 'Tick each job when it is complete.'}</p>
    </div>}
    {view === 'mine' && employee?.id && <RoutineDayList title="My routines" rows={myRows} day={day} today={today} query={ownDay} onTick={setTick} viewingAsEmployee={viewingAsEmployee} />}
    {view === 'team' && seesTeam && <>
      {teamSection === 'daily' ? <RoutineDayList title="Team routines" rows={teamDay.data ?? []} day={day} today={today} query={teamDay} onTick={setTick} showEmployee viewingAsEmployee={viewingAsEmployee} />
        : <RoutineStatistics rows={stats.data ?? []} {...range} today={today} onRangeChange={setRange} invalidRange={invalidRange}
          isLoading={stats.isLoading} error={stats.error} onRetry={stats.refetch} />}
    </>}
    {view === 'manage' && canDefine && <section className="premium-card space-y-4" aria-label="Manage routine assignments">
      <h3 className="text-base font-bold">Assigned routines</h3>
      <p className="text-sm text-neutral-500">Each row is one employee’s routine. Changes to its jobs or schedule begin on a future date.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-sm"><span>Search assigned routines</span><input type="search" className={INPUT} value={manageSearch} onChange={(event) => setManageSearch(event.target.value)} placeholder="Routine, employee or designation" /></label>
        <label className="space-y-1 text-sm"><span>Frequency</span><select className={INPUT} value={manageFrequency} onChange={(event) => setManageFrequency(event.target.value)}><option value="">All frequencies</option>{FREQUENCIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="space-y-1 text-sm"><span>Schedule status</span><select className={INPUT} value={manageStatus} onChange={(event) => setManageStatus(event.target.value)}><option value="active">Active and upcoming</option><option value="all">All schedules</option><option value="archived">Archived</option></select></label>
        <RoutineOrgFilters employees={(sets.data ?? []).map((routine) => routine.employee)} value={manageOrg} onChange={setManageOrg} />
      </div>
      {sets.isLoading ? <SkeletonRows rows={4} avatar={false} label="Loading assigned routines" />
        : sets.error ? <RoutineError error={sets.error} onRetry={sets.refetch} />
          : visibleSets.length === 0 ? <p className="py-8 text-center text-sm text-neutral-500">No routine assignments match these filters.</p>
            : <div className="divide-y divide-neutral-200 dark:divide-neutral-800">{managePager.slice.map((routine) => <article key={routine.id} className="flex flex-wrap items-start justify-between gap-3 py-4">
              <div className="min-w-0 flex-1"><h4 className="break-words text-sm font-bold">{routine.title}</h4><p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">{routine.employee?.full_name ?? 'Employee'} · {routine.employee?.employee_code}</p>
                <p className="mt-1 text-xs text-neutral-500">{routineScheduleLabel(routine)} · {routine.jobs?.filter((job) => job.is_active !== false).length ?? 0} jobs</p>
                {routine.jobs?.some((job) => job.is_active === false) && <p className="mt-1 text-xs text-neutral-500">Retired jobs remain in completion history.</p>}
                <p className="mt-1 text-xs text-neutral-500">{routine.start_date}{lastScheduledDay(routine) ? ` to ${lastScheduledDay(routine)}` : ' onwards'}{lastScheduledDay(routine) === today ? ' · Ends today' : ''}</p>
                {routine.detail && <p className="mt-2 break-words text-sm text-neutral-500">{routine.detail}</p>}</div>
              {routine.can_manage === true && !viewingAsEmployee && !routine.replaced_by && !routine.retired_on
                && (!lastScheduledDay(routine) || lastScheduledDay(routine) > today) && <div className="flex flex-wrap gap-2">
                <button type="button" className={btnClass('ghost')} onClick={() => beginEdit(routine)}><PenLine size={15} />Edit routine</button>
                <button type="button" className={btnClass('ghost')} onClick={() => { retire.reset(); setRetiring(routine); }}><Archive size={15} />Retire routine</button>
              </div>}
            </article>)}</div>}
      <div className="paged-collection"><Pagination {...managePager} noun="routine assignments" sizes={[25, 50, 100]} /></div>
    </section>}
    {retiring && <ConfirmDialog title="Retire this routine?" confirmLabel="Retire routine" busy={retire.isPending} error={humanDbError(retire.error)}
      onCancel={() => { if (!retire.isPending) setRetiring(null); }} onConfirm={async () => {
        try { await retire.mutateAsync(retiring.id); setRetiring(null); setMessage('Routine retired after today. Its completion history is preserved.'); }
        catch { /* The dialog shows the refusal. */ }
      }}><p>{retiring.title} for {retiring.employee?.full_name ?? 'this employee'} will stop after today. Earlier jobs and completions remain in history.</p></ConfirmDialog>}
  </div>;
}

function RoutineError({ error, onRetry }) {
  return <div role="alert" className="flex items-start gap-2 rounded-xl border border-rose-200 dark:border-rose-900 p-4 text-sm text-rose-700 dark:text-rose-300"><AlertTriangle size={17} className="shrink-0" />
    <span>{humanDbError(error)} <button type="button" className="underline" onClick={onRetry}>Retry routines</button></span></div>;
}

export function RoutineDayList({ title, rows, day, today, query, onTick, showEmployee = false, viewingAsEmployee = false }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [frequency, setFrequency] = useState('');
  const [orgFilters, setOrgFilters] = useState({});
  const groups = useMemo(() => groupRoutineDay(rows), [rows]);
  const filtered = filterRoutineGroups(groups, { query: search, status, frequency, ...orgFilters });
  const pager = usePagination(filtered, 10, null, `${day}:${search}:${status}:${frequency}:${orgFilters.designationId}:${orgFilters.departmentId}:${orgFilters.branchId}`);
  return <section className="space-y-3" aria-label={`${title} for ${day}`}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-base font-bold">{title}</h3><span className="text-sm text-neutral-500">{filtered.length < groups.length ? `${filtered.length} of ${groups.length}` : groups.length} routine{groups.length === 1 ? '' : 's'} due</span></div>
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="space-y-1 text-sm"><span>Search {showEmployee ? 'team routines' : 'my routines'}</span><input type="search" className={INPUT} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={showEmployee ? 'Employee, routine or job' : 'Routine or job'} /></label>
      <label className="space-y-1 text-sm"><span>Routine progress</span><select className={INPUT} value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All progress</option><option value="owing">Still to do</option><option value="finished">Finished</option></select></label>
      <label className="space-y-1 text-sm"><span>Routine frequency</span><select className={INPUT} value={frequency} onChange={(event) => setFrequency(event.target.value)}><option value="">All frequencies</option>{FREQUENCIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {showEmployee && <RoutineOrgFilters employees={groups.map((group) => group.employee)} value={orgFilters} onChange={setOrgFilters} />}
    </div>
    {query.isLoading ? <SkeletonRows rows={5} avatar={false} label="Loading scheduled routines" />
      : query.error ? <RoutineError error={query.error} onRetry={query.refetch} />
        : filtered.length === 0 ? <p className="premium-card py-8 text-center text-sm text-neutral-500">{groups.length ? 'No routines match these filters.' : `No routines are due on ${day}.`}</p>
          : filtered && pager.slice.map((group) => <RoutineJobCard key={`${group.employeeId}:${group.routineId}`} group={group} day={day} today={today} onTick={onTick} showEmployee={showEmployee} viewingAsEmployee={viewingAsEmployee} />)}
    <Pagination {...pager} noun={showEmployee ? 'team routines' : 'my routines'} sizes={[10, 25, 50]} />
  </section>;
}

export function RoutineJobCard({ group, day, today, onTick, showEmployee, viewingAsEmployee }) {
  const pager = usePagination(group.list, 10, null, `${day}:${group.routineId}`);
  return <article className="premium-card space-y-3">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h4 className="break-words text-sm font-bold">{group.routineName}</h4>
      {showEmployee && <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">{group.employee?.full_name ?? 'Employee'} · {group.employee?.employee_code}</p>}
      <p className="mt-1 text-xs text-neutral-500">{routineScheduleLabel(group.schedule)} · {day}</p></div>
      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${group.complete ? 'bg-brand-soft text-brand-ink' : 'bg-neutral-100 dark:bg-neutral-900 text-neutral-600 dark:text-neutral-300'}`} aria-label={`${group.done} of ${group.total} jobs completed`}>{group.done}/{group.total}</span></div>
    <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">{pager.slice.map((item) => {
      const Icon = item.done ? CheckSquare : Square;
      const enabled = item.can_tick === true && (!viewingAsEmployee || day === today);
      return <li key={item.id}><button type="button" className="flex min-h-12 w-full items-start gap-3 py-3 text-left disabled:cursor-default" disabled={!enabled || onTick.isPending}
        aria-pressed={item.done} aria-label={`${item.done ? 'Untick' : 'Tick'} ${item.title}`}
        onClick={() => onTick.mutate({ itemId: item.id, employeeId: item.employee_id, onDate: day, done: !item.done })}>
        <Icon size={19} className={`mt-0.5 shrink-0 ${item.done ? 'text-brand-ink' : 'text-neutral-400'}`} /><span className="min-w-0">
          <span className={`block break-words text-sm font-semibold ${item.done ? 'text-neutral-500 line-through' : 'text-neutral-800 dark:text-neutral-200'}`}>{item.title}</span>
          {item.detail && <span className="mt-1 block break-words text-xs text-neutral-500">{item.detail}</span>}</span></button></li>;
    })}</ul>
    <div className="paged-collection"><Pagination {...pager} noun="jobs" sizes={[10, 25, 50]} /></div>
  </article>;
}
