// Attendance screen.
//
// Attendance is DERIVED from BioTime face-terminal punches by the engine in services/attendance —
// there is no punch button here any more, because punching happens at the terminal. What this
// screen does is show what the engine concluded, surface the exceptions HR must act on, and let
// people raise a correction when the device missed something.
import { Skeleton, SkeletonRows, SkeletonTable } from './ui/Skeleton';
import React, { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Clock, Users, AlertTriangle, CalendarDays, Loader2, Download, RefreshCw,
  CheckCircle2, XCircle, ChevronLeft, ChevronRight, Search, FileSpreadsheet, MapPin, UserX, AlertCircle,
  SlidersHorizontal, Fingerprint, TrendingUp, ArrowLeft,
} from 'lucide-react';
import {
  useAttendanceSummary, useMonthlyAttendance, useAttendanceExceptions,
  useRawPunches,
  todayIso, STATUS_STYLES, STATUS_CODES, fmtTime, fmtMinutes,
} from '../data/attendance';
import {
  useRegularizations, useMyRegularizations, useCreateRegularization, useDecideRegularization,
} from '../data/regularizations';
import { useAuth } from '../auth/AuthContext';
import { usePermissions } from '../auth/usePermissions';
import { useEmployees } from '../data/employees';
import { usePayrollAttendanceSummary } from '../data/payrollWorksheet';
import PunchTimeline, { BreakSummary } from './ui/PunchTimeline';
import PunchDetails from './ui/PunchDetails';
import { firstRecordedPunch, latestRecordedPunch, punchDate } from '../lib/recordedPunches';
import Pagination, { usePagination } from './ui/Pagination';
import FilterSelect from './ui/FilterSelect';
import MonthPicker from './ui/MonthPicker';
import FilterSheet, { PhoneSearch, SheetField } from './ui/FilterSheet';
import ListSearch from './ui/ListSearch';
import DateRangeFilter, { useDateRange } from './ui/DateRangeFilter';
import { useSyncHealth, DIAGNOSIS, forHumans, useQueuedExport, useQueuedRecompute } from '../data/syncStatus';
import EmployeeLink from './ui/EmployeeLink';
import { useUrlTab } from '../lib/useUrlTab';
import { useFocusRow } from '../lib/useFocusRow';
import EmployeeAttendanceDetail from './EmployeeAttendanceDetail';
import { humanDbError } from '../lib/dbErrors';
import { correctionDateLabel, regularizationTimes } from '../lib/regularizationTimes';
import { needsPunchFix } from '../lib/attendanceIssues';
import { attendanceTimeline } from '../lib/attendanceTimeline';
import { useSectionCounts } from '../data/sectionCounts';
import { navigationCountLabel, navigationScreenCount } from '../lib/navigationCounts';
import { NavigationCountBadge } from './ui/CountBadge';
import { btnClass } from './ui/Btn';
import { useMediaQuery } from '../lib/useMediaQuery';
import { moveMonth } from '../lib/weekStrip';
import MyDayPhone from './attendance/MyDayPhone';
import PageHeader from './ui/PageHeader';
import { StatCard, StatRow } from './ui/StatCard';
import StatusPill from './ui/StatusPill';
import Avatar from './ui/Avatar';

import SearchSelect from './ui/SearchSelect';
/**
 * `scoped` means the tab is an OVERSIGHT view of other people, so it needs the permission held
 * beyond your own record — canBeyondSelf, not canAny.
 *
 * Today is the whole-company roster board: a six-tile KPI strip and Company / Branch / Department
 * pickers. It had no gate at all, and this screen is in the ESS sidebar as "My Attendance", so a
 * self-scoped employee landed on it by default and was handed an admin-shaped control surface over
 * a board containing exactly one row — their own. That is the "employee can see admin level
 * filters" report, in its original form.
 */
/**
 * `self` is the mirror image: the tab shows ONE person's records — yours — and nobody else's.
 *
 * Monthly calendar is exactly that. It is `<CalendarView employeeId={employee.id}>`, your own
 * month, and it had no gate at all, so an HR manager working as HR was handed a tab about
 * themselves in the middle of a screen they had opened to look at the workforce. The oversight
 * answer to "how has this person's month gone" is By person, which is a different tab on a
 * different screen and takes an employee. Somebody who holds both roles reaches their own month by
 * switching to Employee on the header chip, which is what that switch is for.
 */
const TABS = [
  { id: 'today', label: 'Today', icon: Users, perm: 'attendance.read', scoped: true },
  { id: 'person', label: 'By person', icon: CalendarDays, perm: 'attendance.read', scoped: true },
  { id: 'calendar', label: 'My monthly calendar', icon: CalendarDays, self: true },
  { id: 'overview', label: 'Overview', icon: TrendingUp, self: true },
  { id: 'exceptions', label: 'Exceptions', icon: AlertTriangle, perm: 'attendance.manage' },
  { id: 'regularizations', label: 'Regularizations', icon: CheckCircle2 },
];

// The page title follows the tab, as on the redesign boards.
const TAB_TITLES = { today: 'Today’s attendance', person: 'Attendance by person', exceptions: 'Attendance exceptions', regularizations: 'Attendance corrections' };

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const employeeScope = person => ({ entityId: person?.entity_id, zoneId: person?.zone_id,
  branchId: person?.branch_id, deptId: person?.department_id, employeeId: person?.id });
const validMonth = value => /^\d{4}-(0[1-9]|1[0-2])$/.test(value ?? '');
const validWorkDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '')
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export function PersonAttendanceView() {
  const { can } = usePermissions();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const people = useEmployees();
  const employees = (people.data ?? []).filter(person => can('attendance.read', employeeScope(person)));
  const [correctionBusy, setCorrectionBusy] = useState(false);
  const employeeId = params.get('employee') ?? '';
  const period = validMonth(params.get('period')) ? params.get('period') : todayIso().slice(0, 7);
  const person = employees.find(item => item.id === employeeId);
  const fromPayroll = params.get('from') === 'payroll';
  const canReadPayroll = Boolean(fromPayroll && person && can('payroll.manage', employeeScope(person)));
  const payrollSummary = usePayrollAttendanceSummary(person?.entity_id, period, { enabled: canReadPayroll });
  const payrollAttendance = canReadPayroll ? payrollSummary.data?.find(row => row.employee_id === person.id) : null;
  const payrollPeriod = validMonth(params.get('payrollPeriod')) ? params.get('payrollPeriod') : period;
  const payrollParams = new URLSearchParams({ period: payrollPeriod, step: 'prepare' });
  if (params.get('entity')) payrollParams.set('entity', params.get('entity'));
  const change = (key, value) => {
    if (correctionBusy) return;
    setParams(current => { const next = new URLSearchParams(current); next.set(key, value); next.delete('correctDate'); return next; }, { replace: true });
  };
  return <div className="space-y-4">
    {fromPayroll && <div className="flex flex-wrap items-center gap-3">
      <button type="button" className={btnClass('ghost', 'sm')} disabled={correctionBusy} onClick={() => navigate(`/payroll/run?${payrollParams}`)}><ArrowLeft size={13} /> Back to payroll</button>
      <p className="text-xs text-neutral-500">{correctionBusy ? 'Save or discard your punch correction before returning to payroll.' : 'Review the issue dates, edit punches here, then return to your payroll worksheet.'}</p>
    </div>}
    <section className="premium-card grid grid-cols-1 sm:grid-cols-2 gap-3">
      <label className="text-xs text-neutral-600 dark:text-neutral-300">Employee
        <SearchSelect aria-label="Attendance employee" className="block w-full mt-1 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 px-3 py-2" value={person?.id ?? ''} onChange={event => change('employee', event.target.value)} disabled={people.isLoading || Boolean(people.error) || correctionBusy}>
          <option value="">Choose an employee…</option>
          {employees.map(item => <option key={item.id} value={item.id}>{item.full_name} · {item.employee_code}</option>)}
        </SearchSelect>
      </label>
      <div className="text-xs text-neutral-600 dark:text-neutral-300">
        <span className="block mb-1">Month</span>
        <MonthPicker disabled={correctionBusy} aria-label="Attendance month" className="w-full" value={period} max={todayIso().slice(0, 7)} onChange={event => { if (validMonth(event.target.value)) change('period', event.target.value); }} />
      </div>
      {people.error && <ErrorNote error={people.error} />}
      {employeeId && !person && !people.isLoading && !people.error && <p role="alert" className="text-xs text-amber-700">This employee is not available in your attendance scope.</p>}
    </section>
    {person && !people.error && <>
      {fromPayroll && canReadPayroll && payrollSummary.isLoading && <p role="status" className="text-xs text-neutral-500">Checking which attendance dates are expected for payroll…</p>}
      {fromPayroll && (payrollSummary.error || !canReadPayroll) && <p role="status" className="text-xs text-amber-700 dark:text-amber-300">Recorded attendance is shown below. Unprocessed dates could not be checked against the payroll employment period.</p>}
      <EmployeeAttendanceDetail key={`${person.id}:${period}`} employee={person} period={period} correctDate={validWorkDate(params.get('correctDate')) ? params.get('correctDate') : null}
        onCorrectionStateChange={setCorrectionBusy} showFilter={params.get('show') || 'all'} onShowChange={value => change('show', value)}
        payrollAttendance={payrollAttendance} fromPayroll={fromPayroll} embedded />
    </>}
  </div>;
}

function DayPunchCorrectionLink({ row }) {
  const { can, viewingAsEmployee } = usePermissions();
  const { employee } = useAuth();
  const scope = { entityId: row.entity_id, zoneId: row.zone_id, branchId: row.branch_id,
    deptId: row.department_id, employeeId: row.employee_id };
  if (viewingAsEmployee || employee?.id === row.employee_id || !can('attendance.manage', scope)) return null;
  // Only on a day whose punches need it (no punch out, a flagged missing punch); every other
  // change is made from Regularizations.
  if (!needsPunchFix(row, todayIso())) return null;
  if (row.is_locked) return <span className="text-2xs text-neutral-500">Published · locked</span>;
  if (row.work_date > todayIso()) return null;
  return <Link className="inline-flex min-h-6 items-center text-xs font-semibold text-coral-700 dark:text-coral-500 hover:underline whitespace-nowrap"
    to={`/attendance/person?employee=${encodeURIComponent(row.employee_id)}&period=${encodeURIComponent(row.work_date.slice(0, 7))}&correctDate=${encodeURIComponent(row.work_date)}`}>Fix missing punch</Link>;
}

// Attendance statuses in the redesign's one colour language.
const ATTENDANCE_TONE = {
  Present: 'success', 'Half Day': 'warning', Absent: 'danger', 'On Leave': 'info', Holiday: 'info',
  'Weekly Off': 'neutral', 'Missing Punch': 'danger', 'No Shift': 'neutral',
};

function StatusBadge({ status, isLop }) {
  return <StatusPill status={isLop ? 'LOP' : status} tone={isLop ? 'danger' : ATTENDANCE_TONE[status] ?? 'neutral'} />;
}

/**
 * The status, read-only.
 *
 * There was a dropdown here that wrote status_override, and status_override beats the engine
 * permanently — `status = coalesce(status_override, excluded.status)`. Attendance is DERIVED from
 * punches, so a hand-set status is a second, contradictory source of truth that no recompute can
 * ever correct. Three rows were pinned that way, one of them to a value the engine had already
 * reached on its own; the override was hiding the fact that the rule worked.
 *
 * The cases it was reached for are handled where they belong: a punch on approved leave cancels
 * that leave date (0084), and a genuinely wrong day is corrected with a regularization, which
 * carries a reason and an approver instead of silently overwriting the record.
 */
function AttendanceStatusControl({ row }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <StatusBadge status={row.status} isLop={row.is_lop} />
    </div>
  );
}

/** A figure that filters the table (2026 redesign number card). `tone` picks the icon tile. */
function Kpi({ icon, label, value, sub, tone = 'slate', onClick, active = false, loading = false }) {
  return (
    <StatCard icon={icon} label={label} value={value} sub={sub} tone={tone} loading={loading}
      onClick={onClick} active={active} title={onClick ? `Show ${label}` : undefined} />
  );
}

function ErrorNote({ error }) {
  if (!error) return null;
  return (
    <div role="alert" className="premium-card border-red-300 dark:border-red-900/60">
      <div className="flex items-start gap-2 text-xs text-red-700 dark:text-red-300">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <span>{humanDbError(error)}</span>
      </div>
    </div>
  );
}

function MyAttendanceHero({ employee, onOpenCalendar, onFixAttendance }) {
  const today = todayIso();
  const [year, month] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  const { data: rows = [], isLoading } = useAttendanceSummary(today);
  const { data: monthRows = [], isLoading: monthLoading } = useMonthlyAttendance(employee?.id, year, month);
  const row = rows.find((r) => r.employee?.id === employee?.id);

  const monthSummary = monthRows.reduce(
    (acc, r) => {
      if (r.status === 'Present' || r.status === 'Half Day') acc.present += 1;
      if (r.status === 'Absent') acc.absent += 1;
      if (r.is_late) acc.late += 1;
      if (r.is_missing_punch) acc.missing += 1;
      return acc;
    },
    { present: 0, absent: 0, late: 0, missing: 0 }
  );

  const state = (() => {
    if (!row) return { title: 'No punch recorded yet', detail: 'Your day will appear here after the terminal syncs.', tone: 'amber' };
    if (row.is_missing_punch) return { title: 'Fix attendance', detail: 'A punch is missing from today. Raise a correction if the terminal missed it.', tone: 'amber' };
    if (row.check_in && !row.check_out) return { title: 'You are checked in', detail: `Started at ${fmtTime(firstRecordedPunch(row))}.`, tone: 'green' };
    if (row.check_out) return { title: 'Attendance recorded', detail: `Worked ${fmtMinutes(row.worked_minutes)} today.`, tone: 'green' };
    return { title: row.status || 'My attendance', detail: 'Your attendance status for today.', tone: 'neutral' };
  })();

  return (
    <section className="premium-card self-service-hero my-attendance-hero" data-tone={isLoading ? 'neutral' : state.tone}>
      <div className="self-service-hero-copy">
        <span className="self-service-eyebrow">My attendance</span>
        {isLoading ? (
          <div className="space-y-3 py-2" role="status" aria-label="Loading your attendance">
            <Skeleton className="h-6 w-52 max-w-full" />
            <Skeleton className="h-3 w-72 max-w-full" />
            <span className="sr-only">Loading your attendance…</span>
          </div>
        ) : <>
        <h2>{state.title}</h2>
        <p>{state.detail}</p>
        </>}
      </div>
      <div className="self-service-hero-stats">
        <button type="button" onClick={onOpenCalendar}>
          <span>First punch</span>
          <strong>{isLoading ? <Skeleton as="span" className="inline-block h-5 w-12 align-middle" /> : fmtTime(firstRecordedPunch(row))}</strong>
        </button>
        <button type="button" onClick={onOpenCalendar}>
          <span>Worked</span>
          <strong>{isLoading ? <Skeleton as="span" className="inline-block h-5 w-12 align-middle" /> : row?.worked_minutes ? fmtMinutes(row.worked_minutes) : '—'}</strong>
        </button>
        <button type="button" onClick={onOpenCalendar}>
          <span>Present</span>
          <strong>{monthLoading ? <Skeleton as="span" className="inline-block h-5 w-8 align-middle" /> : monthSummary.present}</strong>
        </button>
        <button type="button" onClick={onFixAttendance}>
          <span>Issues</span>
          <strong>{monthLoading ? <Skeleton as="span" className="inline-block h-5 w-8 align-middle" /> : monthSummary.late + monthSummary.missing + monthSummary.absent}</strong>
        </button>
      </div>
      <div className="self-service-hero-actions">
        <button type="button" data-primary="true" onClick={onFixAttendance}>
          <Fingerprint size={14} /> Fix attendance
        </button>
        <button type="button" onClick={onOpenCalendar}>
          <CalendarDays size={14} /> Monthly view
        </button>
      </div>
    </section>
  );
}

const ALL_ROWS = 'All rows';

/**
 * Filters that test a FLAG on the row rather than its status.
 *
 * The distinction is the whole bug this fixes. `status` only ever holds Present / Absent /
 * Weekly Off; missing punches, late arrivals and short days are booleans alongside it. A filter
 * named for one of those and then compared against `status` matches nothing, which is what the
 * Missing punch tile did — it showed a count of 2,606 and emptied the list when you clicked it.
 *
 * Everything that filters by flag belongs here, and the dropdown is built from these keys, so the
 * tiles, the dropdown and the predicate cannot drift apart again.
 */
const FLAG_FILTERS = {
  'Checked in': (row) => Boolean(row.check_in),
  'On site now': (row) => Boolean(row.check_in && !row.check_out),
  'Late arrivals': (row) => Boolean(row.is_late),
  'Missing punch': (row) => Boolean(row.is_missing_punch),
  'Short days': (row) => Boolean(row.is_short_day),
  // Same definition as the Exceptions tab, or the two disagree about the same day.
  Exceptions: (row) => hasAttendanceException(row),
};

function hasAttendanceException(row) {
  return (
    row.is_missing_punch || row.is_short_day || row.is_long_break || row.breaks_incomplete
    || row.is_late || row.is_early_exit
  );
}

// ---------------------------------------------------------------------------
// Today — who is in
// ---------------------------------------------------------------------------

function TodayView({ workDate, setWorkDate }) {
  const { data = [], isLoading, error, summary, refetch, isFetching } = useAttendanceSummary(workDate);
  // Only meaningful while looking at today: a stalled terminal cannot explain a gap in last March.
  const { data: health } = useSyncHealth();
  const isToday = workDate === todayIso();
  const [query, setQuery] = useState('');
  const [attendanceFilter, setAttendanceFilter] = useState('All rows');
  // Where, as well as what. A day is 242 rows across 4 companies and 46 branches; a shop manager
  // asking "who is in at Chalakudy today" could not get there from a status filter alone.
  const [company, setCompany] = useState('All companies');
  const [branch, setBranch] = useState('All branches');
  const [dept, setDept] = useState('All departments');
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Options come from the day's own rows, so they never offer a branch with nobody in it.
  const { companyOptions, branchOptions, deptOptions, attendanceOptions } = useMemo(() => {
    const c = new Set(), b = new Set(), d = new Set(), st = new Set();
    for (const row of data) {
      if (row.employee?.entity?.name) c.add(row.employee.entity.name);
      const bn = row.employee?.branch?.name || row.employee?.branch?.code;
      if (bn) b.add(bn);
      if (row.employee?.department?.name) d.add(row.employee.department.name);
      if (row.status) st.add(row.status);
    }
    // Ordered by how often it is looked for, not alphabetically: the exceptions belong near the
    // top because they are the reason somebody opens this filter at all.
    const ORDER = ['Present', 'Absent', 'Half Day', 'Missing Punch', 'On Leave', 'No Shift', 'Weekly Off', 'Holiday'];
    const ranked = [...st].sort((x, y) => {
      const ix = ORDER.indexOf(x), iy = ORDER.indexOf(y);
      return (ix === -1 ? ORDER.length : ix) - (iy === -1 ? ORDER.length : iy) || x.localeCompare(y);
    });
    return {
      companyOptions: ['All companies', ...[...c].sort()],
      branchOptions: ['All branches', ...[...b].sort()],
      deptOptions: ['All departments', ...[...d].sort()],
      // The flag filters first, then whatever statuses the day actually contains. Built from the
      // same map the filter reads, so a filter can never be offered that nothing implements — or
      // implemented and never offered, which is how Missing punch ended up reachable only from a
      // KPI card that then matched nothing.
      attendanceOptions: [ALL_ROWS, ...Object.keys(FLAG_FILTERS), ...ranked],
    };
  }, [data]);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return data.filter((row) => {
      // Either the filter names a flag, or it names a status. Anything not in FLAG_FILTERS is
      // matched against row.status — which is why 'Missing Punch' used to empty the list: it is a
      // flag on the row, never a value of status, so the comparison failed for every row.
      const byFlag = FLAG_FILTERS[attendanceFilter];
      if (byFlag) {
        if (!byFlag(row)) return false;
      } else if (attendanceFilter !== ALL_ROWS && row.status !== attendanceFilter) {
        return false;
      }
      if (company !== 'All companies' && row.employee?.entity?.name !== company) return false;
      if (branch !== 'All branches'
          && (row.employee?.branch?.name || row.employee?.branch?.code) !== branch) return false;
      if (dept !== 'All departments' && row.employee?.department?.name !== dept) return false;
      if (!term) return true;
      return (
        row.employee?.full_name?.toLowerCase().includes(term) ||
        row.employee?.employee_code?.toLowerCase().includes(term) ||
        row.employee?.branch?.name?.toLowerCase().includes(term)
      );
    });
  }, [data, query, attendanceFilter, company, branch, dept]);

  // 242 people is 242 rows a day, so the table pages. Declared after `filtered` and before any
  // early return, so the hook order is identical on every render.
  const pager = usePagination(filtered, 25, null, `${workDate}:${query}:${attendanceFilter}:${company}:${branch}:${dept}`);

  const activeFilters =
    (query ? 1 : 0) + (company !== 'All companies' ? 1 : 0) +
    (branch !== 'All branches' ? 1 : 0) + (dept !== 'All departments' ? 1 : 0) +
    (attendanceFilter !== 'All rows' ? 1 : 0);
  const clearFilters = () => {
    setQuery(''); setCompany('All companies'); setBranch('All branches');
    setDept('All departments'); setAttendanceFilter('All rows');
    setFiltersOpen(false);
  };

  // A phone keeps the search above the list and moves the date and the dropdowns into a sheet, so
  // the sheet's count includes a date other than today.
  const phone = useMediaQuery('(max-width: 640px)');
  const sheetCount = activeFilters - (query ? 1 : 0) + (isToday ? 0 : 1);
  const clearSheet = () => {
    setCompany('All companies'); setBranch('All branches'); setDept('All departments');
    setAttendanceFilter('All rows'); setWorkDate(todayIso());
  };
  const placeFilters = (
    <>
      <FilterSelect label="Company" value={company} options={companyOptions}
        onChange={setCompany} allValue="All companies" />
      <FilterSelect label="Branch" value={branch} options={branchOptions}
        onChange={setBranch} allValue="All branches" />
      <FilterSelect label="Dept" value={dept} options={deptOptions}
        onChange={setDept} allValue="All departments" />
      <FilterSelect label="Attendance" value={attendanceFilter} options={attendanceOptions}
        onChange={setAttendanceFilter} allValue="All rows" />
    </>
  );

  const activeFilterChips = [
    phone && !isToday ? { id: 'date', label: workDate, clear: () => setWorkDate(todayIso()) } : null,
    query && !phone ? { id: 'query', label: `Search: ${query}`, clear: () => setQuery('') } : null,
    attendanceFilter !== 'All rows'
      ? { id: 'attendance', label: attendanceFilter, clear: () => setAttendanceFilter('All rows') }
      : null,
    company !== 'All companies' ? { id: 'company', label: company, clear: () => setCompany('All companies') } : null,
    branch !== 'All branches' ? { id: 'branch', label: branch, clear: () => setBranch('All branches') } : null,
    dept !== 'All departments' ? { id: 'dept', label: dept, clear: () => setDept('All departments') } : null,
  ].filter(Boolean);

  return (
    <div className="space-y-4">
      {/* Shown here, and not only on the sync screen, because this is where a stalled terminal is
          actually noticed: everyone reads as "no punch out" and the day looks like mass absence.
          On 29 July the machine stopped uploading at 13:07 and nothing said so for five hours. */}
      {isToday && health?.brokenHop ? (
        <div className="premium-card attendance-sync-warning border-amber-300 dark:border-amber-900/60">
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="text-xs text-amber-800 dark:text-amber-200">
              <span className="font-bold">
                {DIAGNOSIS[health.level].label} — nothing has arrived for {forHumans(health.minutes)}.
              </span>{' '}
              {DIAGNOSIS[health.level].hint} The figures below stop at that point, so people still
              at work will show as having no punch out.
            </div>
          </div>
        </div>
      ) : null}

      {isToday && health && !health.brokenHop && (
        <p className="attendance-sync-pill" role="status">
          <span aria-hidden="true" />Device sync healthy{Number.isFinite(health.minutes) ? ` · updated ${forHumans(health.minutes)} ago` : ''}
        </p>
      )}

      {/* Every tile sets a filter the predicate actually implements — the keys come from
          FLAG_FILTERS or from a real status value, never from a label typed by hand. */}
      <StatRow label="Today’s attendance figures">
        <Kpi icon={Users} label="Roster" value={summary.total} sub="Scheduled" loading={isLoading}
          onClick={() => setAttendanceFilter(ALL_ROWS)} active={attendanceFilter === ALL_ROWS} />
        <Kpi icon={CheckCircle2} label="Checked in" value={summary.checkedIn} tone="green" loading={isLoading}
          sub={summary.total ? `${Math.round((summary.checkedIn / summary.total) * 1000) / 10}% of roster` : undefined}
          onClick={() => setAttendanceFilter('Checked in')} active={attendanceFilter === 'Checked in'} />
        <Kpi icon={MapPin} label="On site now" value={summary.stillIn} tone="blue" loading={isLoading}
          onClick={() => setAttendanceFilter('On site now')} active={attendanceFilter === 'On site now'} />
        <Kpi icon={Clock} label="Late" value={summary.late} tone="amber" loading={isLoading}
          onClick={() => setAttendanceFilter('Late arrivals')} active={attendanceFilter === 'Late arrivals'} />
        <Kpi icon={UserX} label="Absent" value={summary.absent} tone="red" loading={isLoading}
          onClick={() => setAttendanceFilter('Absent')} active={attendanceFilter === 'Absent'} />
        <Kpi icon={AlertCircle} label="Missing punch" value={summary.missingPunch} tone="violet" loading={isLoading}
          onClick={() => setAttendanceFilter('Missing punch')} active={attendanceFilter === 'Missing punch'} />
      </StatRow>

      {phone ? (
        <div className="space-y-2">
          <div className="phone-filter-bar">
            <PhoneSearch value={query} onChange={(e) => setQuery(e.target.value)} label="Search employees" placeholder="Search people…" />
            <FilterSheet count={sheetCount} onClear={clearSheet} title="Filter attendance">
              <SheetField label="Date">
                <input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value || todayIso())} />
              </SheetField>
              {placeFilters}
            </FilterSheet>
            <button type="button" onClick={() => refetch()} className="filter-sheet-button is-icon" title="Refresh" aria-label="Refresh">
              <RefreshCw size={16} className={isFetching ? 'animate-spin' : ''} />
            </button>
          </div>
          {activeFilterChips.length > 0 && (
            <div className="mobile-active-filter-row flex flex-wrap items-center gap-1.5">
              {activeFilterChips.map((chip) => (
                <button key={chip.id} type="button" onClick={chip.clear} title={`Remove ${chip.label}`}
                  className="active-filter-chip inline-flex items-center gap-1.5 rounded-full border border-brand/25 bg-brand/10 px-2.5 py-1 text-xs font-bold text-brand-ink dark:text-brand-ink">
                  <span className="truncate">{chip.label}</span>
                  <XCircle size={12} />
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
      <div className="premium-card mobile-filter-card space-y-3">
        <div className="mobile-toolbar attendance-today-toolbar flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={workDate}
            onChange={(e) => setWorkDate(e.target.value || todayIso())}
            aria-label="Attendance date"
            className="bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 px-3 py-1.5 rounded-xl text-xs"
          />
          <div className="relative flex-1 min-w-0 sm:min-w-45">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" aria-hidden="true" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search employees"
              placeholder="Search name, code or branch…"
              className="w-full bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 pl-8 pr-3 py-1.5 rounded-xl text-xs"
            />
          </div>
          <button
            onClick={() => refetch()}
            className="p-2 rounded-xl bg-neutral-100 dark:bg-neutral-900 hover:bg-neutral-200 dark:hover:bg-neutral-800 text-neutral-600 dark:text-neutral-300"
            title="Refresh" aria-label="Refresh"
          >
            <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} />
          </button>
        </div>

        <div className="mobile-active-filter-row flex flex-wrap items-center gap-1.5">
          {activeFilterChips.map((chip) => (
            <button
              key={chip.id}
              onClick={chip.clear}
              className="active-filter-chip inline-flex items-center gap-1.5 rounded-full border border-brand/25 bg-brand/10 px-2.5 py-1 text-xs font-bold text-brand-ink dark:text-brand-ink"
              title={`Remove ${chip.label}`}
            >
              <span className="truncate">{chip.label}</span>
              <XCircle size={12} />
            </button>
          ))}
          {activeFilters > 0 && (
            <button onClick={clearFilters} className="text-xs font-bold text-neutral-450 hover:text-red-600">
              Clear all
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={() => setFiltersOpen((v) => !v)}
          aria-expanded={filtersOpen}
          className="mobile-filter-toggle sm:hidden"
        >
          <span className="inline-flex items-center gap-1.5">
            <SlidersHorizontal size={14} /> More filters
          </span>
          <span>{activeFilters ? `${activeFilters} active` : 'Optional'}</span>
        </button>

        {/* Where — company, branch, department. The status chips below answer "what". */}
        <div className={`attendance-filter-row mobile-filter-panel ${filtersOpen ? 'is-open' : ''} grid grid-cols-1 sm:flex sm:flex-wrap sm:items-center gap-2 pt-2.5 border-t border-neutral-100 dark:border-neutral-850`}>
          {placeFilters}
          {activeFilters > 0 && (
            <button onClick={clearFilters}
              className="hidden sm:inline-flex items-center justify-center gap-1.5 text-xs font-bold text-neutral-500 hover:text-red-600 dark:hover:text-red-400 cursor-pointer sm:ml-auto py-1.5">
              <XCircle size={12} /> Clear {activeFilters} filter{activeFilters === 1 ? '' : 's'}
            </button>
          )}
        </div>
      </div>
      )}

      <ErrorNote error={error} />

      <div className="premium-card overflow-hidden">
        {isLoading ? (
          <SkeletonTable rows={6} columns={10} label="Loading daily attendance" />
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center text-xs text-neutral-500">
            No attendance rows for {workDate}.
            <div className="mt-1 text-xs text-neutral-400">
              If punches exist but rows do not, the engine has not processed this date yet.
            </div>
          </div>
        ) : (
          <>
            <div className="table-scroll">
              <table className="premium-table phone-rows w-full text-xs">
              <thead>
                <tr>
                  <th className="text-left">Employee</th>
                  <th className="text-left">Branch</th>
                  <th className="text-left">Shift</th>
                  <th className="text-left">First punch</th>
                  <th className="text-left">Latest punch</th>
                  <th className="text-left">Punches</th>
                  <th className="text-left">Worked</th>
                  <th className="text-left hidden lg:table-cell" title="Breaks taken today and total time out">Breaks</th>
                  <th className="text-left">OT</th>
                  <th className="text-left">Status</th>
                </tr>
              </thead>
              <tbody>
                {pager.slice.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Employee">
                      <div className="flex items-center gap-2.5 font-semibold text-neutral-800 dark:text-neutral-100">
                        <Avatar name={row.employee?.full_name} size="md" />
                        <EmployeeLink employee={row.employee} />
                      </div>
                      <div className="text-2xs text-neutral-400 font-mono">
                        {row.employee?.employee_code ?? ''}
                      </div>
                    </td>
                    <td data-label="Branch" className="text-neutral-500">{row.employee?.branch?.name ?? '—'}</td>
                    <td data-label="Shift" className="text-neutral-500">{row.shift?.code ?? '—'}</td>
                    <td data-label="First punch" className={`font-mono ${row.is_late ? 'text-amber-600 dark:text-amber-400 font-bold' : ''}`}>
                      {fmtTime(firstRecordedPunch(row))}
                      {row.is_late ? <span className="ml-1 text-2xs">+{row.late_minutes}m</span> : null}
                    </td>
                    <td data-label="Latest punch" className={`font-mono ${row.is_early_exit ? 'text-amber-600 dark:text-amber-400' : ''}`}>
                      {fmtTime(latestRecordedPunch(row))}
                    </td>
                    <td data-label="Punches"><PunchDetails row={row} /></td>
                    <td data-label="Worked" className="font-mono">{fmtMinutes(row.worked_minutes)}</td>
                    <td data-label="Breaks" className="hidden lg:table-cell font-mono"><BreakSummary row={row} /></td>
                    <td data-label="OT" className="font-mono text-emerald-600 dark:text-emerald-400">
                      {fmtMinutes(row.ot_minutes)}
                    </td>
                    <td data-label="Status">
                      <AttendanceStatusControl
                        row={row}
                      />
                      <div className="mt-1.5"><DayPunchCorrectionLink row={row} /></div>
                    </td>
                  </tr>
                ))}
              </tbody>
              </table>
            </div>
            <Pagination {...pager} noun="rows" />
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Monthly calendar
// ---------------------------------------------------------------------------

function CalendarView({ employeeId, employeeName, selectedDate, onSelectDate }) {
  const now = new Date();
  const [ownYear, setYear] = useState(now.getFullYear());
  const [ownMonth, setMonth] = useState(now.getMonth() + 1);
  const [ownSelected, setOwnSelected] = useState(null);
  // On a phone the chosen day is shared with the day ring above (round 2): the calendar follows it
  // and picking a day here shows that day in the ring.
  const controlled = typeof onSelectDate === 'function' && Boolean(selectedDate);
  const year = controlled ? Number(selectedDate.slice(0, 4)) : ownYear;
  const month = controlled ? Number(selectedDate.slice(5, 7)) : ownMonth;
  const selected = controlled ? selectedDate : ownSelected;
  const setSelected = (date) => {
    if (!controlled) return setOwnSelected(date);
    if (!date) return;
    onSelectDate(date);
    document.querySelector('.my-day-phone')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  };

  const { data = [], isLoading, error } = useMonthlyAttendance(employeeId, year, month);
  const { data: punches = [] } = useRawPunches(employeeId, selected);

  const byDate = useMemo(() => new Map(data.map((r) => [r.work_date, r])), [data]);

  const cells = useMemo(() => {
    const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const out = Array.from({ length: firstDow }, () => null);
    for (let d = 1; d <= daysInMonth; d++) {
      out.push(`${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
    return out;
  }, [year, month]);

  const totals = useMemo(
    () =>
      data.reduce(
        (acc, r) => {
          acc.payable += Number(r.day_fraction ?? 0);
          acc.ot += Number(r.ot_minutes ?? 0);
          if (r.status === 'Absent') acc.absent += 1;
          if (r.is_late) acc.late += 1;
          if (r.status === 'On Leave') acc.leave += 1;
          return acc;
        },
        { payable: 0, ot: 0, absent: 0, late: 0, leave: 0 }
      ),
    [data]
  );

  const shiftMonth = (delta) => {
    const next = new Date(Date.UTC(year, month - 1 + delta, 1));
    if (controlled) return onSelectDate(moveMonth(selectedDate, delta, todayIso()));
    setYear(next.getUTCFullYear());
    setMonth(next.getUTCMonth() + 1);
    setSelected(null);
  };

  const selectedRow = selected ? byDate.get(selected) : null;
  const punchTimes = useMemo(
    // The raw query includes adjacent dates for night shifts. Without a computed row, show
    // only records on the selected calendar date rather than merging neighboring workdays.
    () => punches.map((p) => p.punch_time).filter((time) => punchDate(time) === selected).sort(),
    [punches, selected]
  );

  if (!employeeId) {
    return (
      <div className="premium-card p-10 text-center text-xs text-neutral-500">
        No employee record is linked to your login, so there is no calendar to show.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="mobile-list-row premium-card calendar-month-bar flex flex-wrap items-center justify-between gap-3">
        <div className="mobile-list-actions flex items-center gap-2">
          <button type="button" onClick={() => shiftMonth(-1)} aria-label="Previous month" title="Previous month" className="p-2 rounded-lg bg-neutral-100 dark:bg-neutral-900 hover:bg-neutral-200 dark:hover:bg-neutral-800">
            <ChevronLeft size={16} />
          </button>
          <span className="text-sm font-bold min-w-37.5 text-center" aria-live="polite">{MONTHS[month - 1]} {year}</span>
          <button type="button" onClick={() => shiftMonth(1)} aria-label="Next month" title="Next month" className="p-2 rounded-lg bg-neutral-100 dark:bg-neutral-900 hover:bg-neutral-200 dark:hover:bg-neutral-800">
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="mobile-list-actions flex flex-wrap gap-4 text-xs">
          <span><b className="font-mono text-emerald-600 dark:text-emerald-400">{totals.payable.toFixed(1)}</b> payable days</span>
          <span><b className="font-mono">{fmtMinutes(totals.ot)}</b> OT</span>
          <span><b className="font-mono text-red-600 dark:text-red-400">{totals.absent}</b> absent</span>
          <span><b className="font-mono text-amber-600 dark:text-amber-400">{totals.late}</b> late</span>
          <span><b className="font-mono">{totals.leave}</b> leave</span>
        </div>
      </div>

      <ErrorNote error={error} />

      <div className="premium-card">
        <div className="mobile-list-row mb-3 flex items-center justify-between gap-2">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-700 dark:text-neutral-200">
              Monthly attendance
            </h3>
            <p className="mt-0.5 text-xs text-neutral-500">{employeeName}</p>
          </div>
          <span className="text-2xs font-bold uppercase tracking-wider text-neutral-400">
            tap a day for punches
          </span>
        </div>

        {isLoading ? (
          <div className="space-y-1.5" aria-hidden="true">
            <div className="grid grid-cols-7 gap-1.5">
              {Array.from({ length: 7 }, (_, index) => <Skeleton key={index} className="h-3 w-8 mx-auto max-w-full" />)}
            </div>
            <div className="grid grid-cols-7 gap-1.5">
              {cells.map((date, index) => date ? <Skeleton key={date} className="aspect-square rounded-xl" /> : <div key={`pad-${index}`} />)}
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-7 gap-1.5 mb-1.5">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
                <div key={d} className="text-xs font-bold uppercase tracking-wider text-neutral-400 text-center">{d}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1.5">
              {cells.map((date, i) => {
                if (!date) return <div key={`pad-${i}`} />;
                const row = byDate.get(date);
                const day = Number(date.slice(-2));
                const isSelected = selected === date;

                return (
                  <button
                    key={date}
                    onClick={() => setSelected(isSelected ? null : date)}
                    className={`aspect-square rounded-xl p-1.5 flex flex-col items-center justify-center border transition-all
                      ${isSelected ? 'ring-2 ring-coral-500 border-transparent' : 'border-neutral-200 dark:border-neutral-850'}
                      ${row ? STATUS_STYLES[row.status] ?? '' : 'bg-neutral-50 dark:bg-neutral-950/40 text-neutral-400'}`}
                    title={row ? `${row.status}${row.remarks ? ` — ${row.remarks}` : ''}` : 'Not processed'} aria-label={row ? `${row.status}${row.remarks ? ` — ${row.remarks}` : ''}` : 'Not processed'}
                  >
                    <span className="text-base font-bold leading-none">{day}</span>
                    <span className="text-2xs font-black mt-0.5 leading-none">
                      {row ? (row.is_lop ? 'LP' : STATUS_CODES[row.status] ?? '·') : '·'}
                    </span>
                    {row?.is_late ? <span className="w-1 h-1 rounded-full bg-red-500 mt-0.5" /> : null}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      {selected ? (
        <div className="premium-card attendance-day-detail space-y-3 animate-fade-in">
          <div className="attendance-day-detail-head">
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-neutral-700 dark:text-neutral-200">
                {selected}
              </h4>
              <p className="mt-0.5 text-xs text-neutral-500">Punch timeline</p>
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="p-1.5 rounded-lg bg-neutral-100 dark:bg-neutral-900 hover:bg-neutral-200 dark:hover:bg-neutral-800 text-neutral-500"
              aria-label="Close day punches"
            >
              <XCircle size={15} />
            </button>
          </div>

          {selectedRow ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <div>
                <div className="text-2xs text-neutral-400 uppercase">Status</div>
                <StatusBadge status={selectedRow.status} isLop={selectedRow.is_lop} />
              </div>
              <div>
                <div className="text-2xs text-neutral-400 uppercase">First / latest punch</div>
                <span className="flex flex-wrap items-center gap-x-1 font-mono">
                  <span className="whitespace-nowrap">{fmtTime(firstRecordedPunch(selectedRow))}</span>
                  <span aria-hidden="true">–</span>
                  <span className="whitespace-nowrap">{fmtTime(latestRecordedPunch(selectedRow))}</span>
                </span>
              </div>
              <div>
                <div className="text-2xs text-neutral-400 uppercase">Worked</div>
                <span className="font-mono">{fmtMinutes(selectedRow.worked_minutes)}</span>
              </div>
              <div>
                <div className="text-2xs text-neutral-400 uppercase">Overtime</div>
                <span className="font-mono">{fmtMinutes(selectedRow.ot_minutes)}</span>
              </div>
              {selectedRow.remarks ? (
                <div className="col-span-full text-xs text-neutral-500">{selectedRow.remarks}</div>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-neutral-500">This date has not been processed by the engine.</p>
          )}

          <div className="soft-divider" />
          <PunchDetails row={selectedRow ?? { work_date: selected, punches: punchTimes }} expanded />
          {attendanceTimeline(selectedRow, punchTimes).length > 0 ? (
            <PunchTimeline
              punches={attendanceTimeline(selectedRow, punchTimes)}
              breakMinutes={selectedRow?.break_minutes}
              incomplete={selectedRow?.breaks_incomplete}
            />
          ) : (
            <p className="text-xs text-neutral-500">No punches recorded around this date.</p>
          )}
        </div>
      ) : null}

      <div className="premium-card overflow-hidden">
        <div className="p-4 pb-2">
          <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-700 dark:text-neutral-200">
            Month record
          </h3>
        </div>

        {isLoading ? (
          <SkeletonTable rows={6} columns={7} label="Loading monthly attendance" />
        ) : data.length === 0 ? (
          <div className="p-8 text-center text-xs text-neutral-500">No attendance rows computed for this month yet.</div>
        ) : (
          <>
          <ul className="month-record-list">
            {data.map((row) => (
              <li key={row.id}>
                <button type="button" className="month-record-row" aria-pressed={selected === row.work_date} onClick={() => setSelected(row.work_date)}>
                  <span className="month-record-date">
                    <span>{new Date(`${row.work_date}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'short' })}</span>
                    <strong>{Number(row.work_date.slice(8))}</strong>
                  </span>
                  <span className="month-record-copy">
                    <strong>{firstRecordedPunch(row) ? `${fmtTime(firstRecordedPunch(row))} – ${fmtTime(latestRecordedPunch(row))}` : 'No punches'}</strong>
                    <span>{row.worked_minutes ? `Worked ${fmtMinutes(row.worked_minutes)}` : row.remarks || '—'}{row.ot_minutes ? ` · OT ${fmtMinutes(row.ot_minutes)}` : ''}</span>
                  </span>
                  <StatusBadge status={row.status} isLop={row.is_lop} />
                </button>
              </li>
            ))}
          </ul>
          <div className="table-scroll month-record-table-wrap">
            <table className="premium-table phone-rows w-full text-xs">
              <thead>
                <tr>
                  <th className="text-left">Date</th>
                  <th className="text-left">Status</th>
                  <th className="text-left">First punch</th>
                  <th className="text-left">Latest punch</th>
                  <th className="text-left">Punches</th>
                  <th className="text-left">Worked</th>
                  <th className="text-left">OT</th>
                </tr>
              </thead>
              <tbody>
                {data.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Date" className="font-mono">{row.work_date}</td>
                    <td data-label="Status">
                      <AttendanceStatusControl row={row} />
                    </td>
                    <td data-label="First punch" className={`font-mono ${row.is_late ? 'text-amber-600 dark:text-amber-400 font-bold' : ''}`}>
                      {fmtTime(firstRecordedPunch(row))}
                    </td>
                    <td data-label="Latest punch" className="font-mono">{fmtTime(latestRecordedPunch(row))}</td>
                    <td data-label="Punches"><PunchDetails row={row} /></td>
                    <td data-label="Worked" className="font-mono">{fmtMinutes(row.worked_minutes)}</td>
                    <td data-label="OT" className="font-mono text-emerald-600 dark:text-emerald-400">{fmtMinutes(row.ot_minutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Exceptions + reports
// ---------------------------------------------------------------------------

export function ExceptionsView() {
  // Exceptions are chased down while they are fresh, so the last week is the useful default.
  const range = useDateRange('week');
  const { from, to } = range;

  const { data = [], isLoading, error, refetch } = useAttendanceExceptions(from, to);
  const [search, setSearch] = useState('');
  const [issue, setIssue] = useState('All exceptions');
  const matching = useMemo(() => {
    const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return data.filter((row) => {
      if (issue === 'Absent' && row.status !== 'Absent') return false;
      if (issue === 'No shift assigned' && row.status !== 'No Shift') return false;
      if (issue === 'Missing punch' && !row.is_missing_punch) return false;
      if (issue === 'Late arrivals' && !row.is_late) return false;
      if (issue === 'Early exits' && !row.is_early_exit) return false;
      if (issue === 'Short days' && !row.is_short_day) return false;
      if (issue === 'Break issues' && !(row.is_long_break || row.breaks_incomplete)) return false;
      const text = [row.employee?.full_name, row.employee?.employee_code, row.employee?.branch?.name, row.work_date, row.status].join(' ').toLocaleLowerCase();
      return terms.every((term) => text.includes(term));
    });
  }, [data, search, issue]);
  const pager = usePagination(matching, 25, null, `${from}:${to}:${search}:${issue}`);
  // Queued through Supabase rather than called directly on the HR laptop. The direct route only
  // ever worked from inside the office over plain http — from the deployed HTTPS site the browser
  // refuses to call it at all, so all three of these buttons did nothing.
  const recompute = useQueuedRecompute();
  const exportRegister = useQueuedExport('register');
  const exportPayroll = useQueuedExport('payroll');

  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [year, setYear] = useState(new Date().getFullYear());

  // The export service resolves scope from branch/zone/entity/global grants only — a department- or
  // self-scoped payslip.read contributes nothing and comes back 403 ("your role has no export
  // scope"). So these are offered on canAcrossBranches, or the buttons would be dead controls.
  const { canAcrossBranches } = usePermissions();
  const canExportRegister = canAcrossBranches('report.read') || canAcrossBranches('attendance.read');
  const canExportPayroll = canAcrossBranches('report.read') || canAcrossBranches('payslip.read');
  const phone = useMediaQuery('(max-width: 640px)');

  const exceptionsList = (
    <>
    <div className="premium-card overflow-hidden">
      {isLoading ? (
        <SkeletonTable rows={6} columns={8} label="Loading attendance exceptions" />
      ) : error ? null : matching.length === 0 ? (
        <div className="p-10 text-center text-xs text-neutral-500">{search.trim() || issue !== 'All exceptions' ? 'No exceptions match your filters.' : 'No exceptions in this range.'}</div>
      ) : (
        <div className="table-scroll">
          <table className="premium-table phone-rows w-full text-xs">
            <thead>
              <tr>
                <th className="text-left">Date</th>
                <th className="text-left">Employee</th>
                <th className="text-left">Branch</th>
                <th className="text-left">Issue</th>
                <th className="text-left">First punch</th>
                <th className="text-left">Latest punch</th>
                <th className="text-left">Punches</th>
                <th className="text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {pager.slice.map((row) => {
                // Ordered by how much somebody needs to act on it, not by column order: an
                // absence is a question for a manager, a long break is only an explanation for
                // why the overtime looks small.
                const shortBy = row.shift?.full_day_minutes
                  ? row.shift.full_day_minutes - (row.worked_minutes ?? 0)
                  : null;
                const issues = [
                  row.status === 'Absent' ? 'Absent' : null,
                  row.status === 'No Shift' ? 'No shift assigned' : null,
                  row.is_missing_punch ? 'Missing punch' : null,
                  // The headline exception on a flexible shift — left early, and nothing else
                  // records it. Still paid in full by policy, which is why it needs saying.
                  row.is_short_day
                    ? `Short${shortBy > 0 ? ` by ${fmtMinutes(shortBy)}` : ''}`
                    : null,
                  row.breaks_incomplete ? 'Break punch missing' : null,
                  row.is_long_break ? `Break ${row.break_minutes}m` : null,
                  row.is_late ? `Late ${row.late_minutes}m` : null,
                  row.is_early_exit ? `Early ${row.early_exit_minutes}m` : null,
                ].filter(Boolean);

                return (
                  <tr key={row.id}>
                    <td data-label="Date" className="font-mono">{row.work_date}</td>
                    <td data-label="Employee">
                      <div className="font-semibold text-neutral-800 dark:text-neutral-100"><EmployeeLink employee={row.employee} /></div>
                      <div className="text-2xs text-neutral-400 font-mono">{row.employee?.employee_code ?? ''}</div>
                    </td>
                    <td data-label="Branch" className="text-neutral-500">{row.employee?.branch?.name ?? '—'}</td>
                    <td data-label="Issue">
                      <div className="flex flex-wrap gap-1">
                        {issues.map((issue) => (
                          <span key={issue} className="badge bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">{issue}</span>
                        ))}
                      </div>
                    </td>
                    <td data-label="First punch" className="font-mono">{fmtTime(firstRecordedPunch(row))}</td>
                    <td data-label="Latest punch" className="font-mono">{fmtTime(latestRecordedPunch(row))}</td>
                    <td data-label="Punches"><PunchDetails row={row} /></td>
                    <td data-label="Status">
                      <AttendanceStatusControl
                        row={row}
                      />
                      <div className="mt-1.5"><DayPunchCorrectionLink row={row} /></div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
    <Pagination {...pager} noun="attendance exceptions" />
    </>
  );
  const recomputeButton = (
    <button
      onClick={() => recompute.mutate({ from, to }, { onSuccess: () => refetch() })}
      disabled={recompute.isPending}
      className={phone ? 'filter-sheet-button' : 'px-3 py-2 rounded-xl bg-brand-action text-brand-on hover:bg-brand-action-hover text-xs font-bold flex items-center gap-1.5 disabled:opacity-50'}
    >
      {recompute.isPending ? <Loader2 size={phone ? 16 : 13} className="animate-spin" /> : <RefreshCw size={phone ? 16 : 13} />}
      {phone ? 'Recompute' : 'Recompute range'}
    </button>
  );
  const recomputeNotes = (
    <>
      {recompute.isError ? <ErrorNote error={recompute.error} /> : null}
      {recompute.isSuccess ? (
        <p className="text-xs text-emerald-600 dark:text-emerald-400">
          {/* Ranges over 31 days come back as 202 {message} with no counts. */}
          {recompute.data?.message ||
            `Recomputed ${recompute.data?.rowsWritten ?? 0} rows across ${recompute.data?.employees ?? 0} employees.`}
        </p>
      ) : null}
    </>
  );
  const issueFilter = (
    <FilterSelect label="Issue" value={issue} onChange={setIssue} allValue="All exceptions"
      options={['All exceptions', 'Absent', 'No shift assigned', 'Missing punch', 'Late arrivals', 'Early exits', 'Short days', 'Break issues']} />
  );

  // On a phone: search and Filters (dates, issue) in one row, then Recompute and the monthly
  // exports — which sit behind a sheet of their own — instead of a tall card of controls.
  if (phone) {
    return (
      <div className="space-y-3">
        <div className="phone-filter-bar">
          <PhoneSearch value={search} onChange={(e) => setSearch(e.target.value)} label="Search attendance exceptions" placeholder="Search exceptions…" />
          <FilterSheet title="Filter exceptions" count={(issue !== 'All exceptions' ? 1 : 0) + (range.preset !== 'week' ? 1 : 0)}
            onClear={() => { setIssue('All exceptions'); range.setPreset('week'); }}>
            <SheetField label="Dates" group><DateRangeFilter {...range} /></SheetField>
            {issueFilter}
          </FilterSheet>
        </div>
        <div className="phone-tool-row">
          {recomputeButton}
          {canExportRegister || canExportPayroll ? (
            <FilterSheet title="Monthly exports" label="Exports" icon={Download} foot={false}>
              <SheetField label="Month">
                <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
                  {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
              </SheetField>
              <SheetField label="Year">
                <input type="number" inputMode="numeric" value={year} onChange={(e) => setYear(Number(e.target.value))} />
              </SheetField>
              <div className="filter-sheet-actions">
                {canExportRegister ? (
                  <button type="button" className={btnClass('ghost')} onClick={() => exportRegister.mutate({ year, month })} disabled={exportRegister.isPending}>
                    {exportRegister.isPending ? <Loader2 size={14} className="animate-spin" /> : <FileSpreadsheet size={14} />} Attendance register
                  </button>
                ) : null}
                {canExportPayroll ? (
                  <button type="button" className={btnClass('ghost')} onClick={() => exportPayroll.mutate({ year, month })} disabled={exportPayroll.isPending}>
                    {exportPayroll.isPending ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} Payroll export
                  </button>
                ) : null}
              </div>
              {exportRegister.isError || exportPayroll.isError ? <ErrorNote error={exportRegister.error || exportPayroll.error} /> : null}
            </FilterSheet>
          ) : null}
        </div>
        {recomputeNotes}
        <ErrorNote error={error} />
        {exceptionsList}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="premium-card space-y-3">
        <div className="mobile-toolbar flex flex-wrap items-center gap-3">
          <DateRangeFilter {...range} />
          {recomputeButton}
        </div>

        {recomputeNotes}

        {canExportRegister || canExportPayroll ? (
          <>
        <div className="soft-divider" />

        <div className="mobile-toolbar flex flex-wrap items-end gap-3">
          <label className="text-2xs uppercase tracking-wider text-neutral-500">
            Report month
            <div className="flex gap-1.5 mt-1">
              <select value={month} onChange={(e) => setMonth(Number(e.target.value))}
                className="bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 px-2 py-1.5 rounded-xl text-xs">
                {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </select>
              <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))}
                className="w-20 bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 px-2 py-1.5 rounded-xl text-xs" />
            </div>
          </label>

          {canExportRegister ? (
            <button
              onClick={() => exportRegister.mutate({ year, month })}
              disabled={exportRegister.isPending}
              className="px-3 py-2 rounded-xl bg-neutral-100 dark:bg-neutral-900 hover:bg-neutral-200 dark:hover:bg-neutral-800 text-xs font-bold flex items-center gap-1.5 disabled:opacity-50"
            >
              {exportRegister.isPending ? <Loader2 size={13} className="animate-spin" /> : <FileSpreadsheet size={13} />}
              Attendance register
            </button>
          ) : null}

          {canExportPayroll ? (
            <button
              onClick={() => exportPayroll.mutate({ year, month })}
              disabled={exportPayroll.isPending}
              className="px-3 py-2 rounded-xl bg-neutral-100 dark:bg-neutral-900 hover:bg-neutral-200 dark:hover:bg-neutral-800 text-xs font-bold flex items-center gap-1.5 disabled:opacity-50"
            >
              {exportPayroll.isPending ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
              Payroll export
            </button>
          ) : null}
        </div>

        {exportRegister.isError || exportPayroll.isError ? (
          <ErrorNote error={exportRegister.error || exportPayroll.error} />
        ) : null}
          </>
        ) : null}
      </div>

      <ErrorNote error={error} />

      <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] gap-2">
        <ListSearch value={search} onChange={setSearch} label="Search attendance exceptions" placeholder="Search employee, code, branch or date…" />
        {issueFilter}
      </div>

      {exceptionsList}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Regularizations
// ---------------------------------------------------------------------------

export function RegularizationsView({ employee, canApprove }) {
  const { can, canBeyondSelf, viewingAsEmployee } = usePermissions();
  const { user } = useAuth();
  const [params] = useSearchParams();
  const onBehalf = !viewingAsEmployee && canBeyondSelf('regularization.create');
  const people = useEmployees({ enabled: onBehalf });
  const eligible = (people.data ?? []).filter(person => can('regularization.create', employeeScope(person)));
  const [selectedId, setSelectedId] = useState(() => onBehalf ? params.get('employee') ?? '' : employee?.id ?? '');
  const target = onBehalf ? eligible.find(person => person.id === selectedId) : employee;
  const canCreate = Boolean(target && can('regularization.create', employeeScope(target)));
  // A regularization notification links straight here — see the 0098 migration, which points the
  // trigger at `attendance/regularizations` instead of the screen's default tab.
  const { focusId, rowProps } = useFocusRow();
  // A reviewer sees the pending queue; everybody else sees THEIR OWN requests. The second argument
  // is what stops "not an approver" from meaning "no filter at all".
  const reviewing = canApprove && !viewingAsEmployee;
  const { data: queue = [], isLoading, error: queueError } = useRegularizations(
    reviewing ? 'Pending' : undefined,
    reviewing ? undefined : employee?.id,
    { enabled: reviewing || Boolean(employee?.id) }
  );

  /**
   * May this reviewer decide THIS request?
   *
   * canApprove alone drew Approve/Reject on every row in the queue — including rows outside the
   * reviewer's scope, where the update silently matches nothing, and their own request, which
   * app.tg_no_self_approval (0072) refuses outright.
   */
  const canDecide = (r) =>
    r.employee_id !== employee?.id
    && r.requested_by !== user?.id
    && can('regularization.approve', {
      entityId: r.entity_id,
      zoneId: r.zone_id,
      branchId: r.branch_id,
      deptId: r.department_id,
      employeeId: r.employee_id,
    });
  const { data: mine = [], isLoading: loadingMine, error: mineError } = useMyRegularizations(employee?.id);
  const create = useCreateRegularization();
  const submitting = useRef(false);
  const decide = useDecideRegularization();

  const [form, setForm] = useState(() => ({ workDate: validWorkDate(params.get('date')) && params.get('date') <= todayIso() ? params.get('date') : todayIso(), checkIn: '', checkOut: '', checkOutNextDay: false, reason: '' }));
  const canReadDay = Boolean(target && can('attendance.read', employeeScope(target)) && validWorkDate(form.workDate));
  const dayQuery = useMonthlyAttendance(canReadDay ? target.id : null, Number(form.workDate.slice(0, 4)), Number(form.workDate.slice(5, 7)));
  const currentDay = dayQuery.data?.find(row => row.work_date === form.workDate);
  const dayReadBlocked = canReadDay && (!dayQuery.isSuccess || dayQuery.isFetching || Boolean(dayQuery.error));
  const locked = Boolean(currentDay?.is_locked);
  const createBlocked = !canCreate || create.isPending || locked || dayReadBlocked || (onBehalf && Boolean(people.error));
  const [search, setSearch] = useState('');
  const [formError, setFormError] = useState('');
  const matching = useMemo(() => {
    const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return queue.filter((r) => {
      const text = [r.employee?.full_name, r.employee?.employee_code, r.employee?.branch?.name, r.reason, r.work_date, r.status].join(' ').toLocaleLowerCase();
      return terms.every((term) => text.includes(term));
    });
  }, [queue, search]);
  const queuePager = usePagination(matching, 25, focusId, `${reviewing}:${employee?.id}:${search}`);
  const minePager = usePagination(mine, 8, reviewing ? focusId : null, employee?.id);

  const submit = async (e) => {
    e.preventDefault();
    if (createBlocked || submitting.current) return;
    setFormError('');
    if (!form.checkIn && !form.checkOut) {
      setFormError('Enter a check-in or check-out time to request a correction.');
      return;
    }
    if (!form.reason.trim()) {
      setFormError('Enter a reason for this correction.');
      return;
    }
    if (form.workDate > todayIso()) { setFormError('Choose today or an earlier work date.'); return; }
    try { regularizationTimes(form); }
    catch (error) {
      setFormError(error.message);
      return;
    }
    submitting.current = true;
    try {
      await create.mutateAsync({ employeeId: target.id, ...form, reason: form.reason.trim() });
      setForm(current => ({ ...current, checkIn: '', checkOut: '', checkOutNextDay: false, reason: '' }));
    } catch { /* The mutation error is visible; keep entered values for a retry. */ }
    finally { submitting.current = false; }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-1 space-y-4">
        <form onSubmit={submit} className="premium-card correction-form space-y-3" aria-busy={create.isPending}>
          <fieldset disabled={create.isPending} className="min-w-0 space-y-3">
          <h3 className="correction-title">Raise a correction</h3>
          <p className="correction-intro">
            {onBehalf ? 'File corrected times for an employee in your scope. Another reviewer must approve a request you file. Original device punches stay unchanged.' : 'Request a correction for a missed punch. Once approved, your attendance for that date is updated.'}
          </p>

          {onBehalf && <label className="correction-field"><span>Employee</span>
            <SearchSelect aria-label="Correction employee" value={target?.id ?? ''} disabled={people.isLoading || Boolean(people.error)} onChange={event => { setSelectedId(event.target.value); setForm(current => ({ ...current, checkIn: '', checkOut: '', checkOutNextDay: false, reason: '' })); setFormError(''); create.reset(); }} className="correction-input">
              <option value="">Choose an employee…</option>
              {eligible.map(person => <option key={person.id} value={person.id}>{person.full_name} · {person.employee_code}</option>)}
            </SearchSelect>
          </label>}
          {onBehalf && people.error && <ErrorNote error={people.error} />}
          {onBehalf && selectedId && !target && !people.isLoading && !people.error && <p role="alert" className="text-xs text-amber-700">This employee is not available in your correction scope.</p>}

          <label className="correction-field">
            <span>Date</span>
            <input type="date" aria-label="Correction date" required max={todayIso()} value={form.workDate}
              onChange={(e) => { const value = e.target.value; setForm(current => ({ ...current, workDate: value })); }}
              className="correction-input" />
          </label>

          {/* What the day holds now, as two short lines beside each other's label. */}
          {currentDay && <dl className="correction-current">
            <div><dt>Recorded punches</dt><dd>{fmtTime(firstRecordedPunch(currentDay))} – {fmtTime(latestRecordedPunch(currentDay))}</dd></div>
            <div><dt>Current attendance</dt><dd>{fmtTime(currentDay.check_in)} – {fmtTime(currentDay.check_out)}{correctionDateLabel(currentDay.check_out, form.workDate)}</dd></div>
          </dl>}
          {locked && <p role="alert" className="text-xs text-amber-700">This day is locked by published payroll. Its punch times cannot be corrected here.</p>}
          {dayQuery.error && <ErrorNote error={dayQuery.error} />}

          {/* Check in and check out side by side at every width — they are one pair of times. */}
          <div className="correction-times">
            <label className="correction-field">
              <span>Check in</span>
              <input type="time" aria-label="Corrected check-in" value={form.checkIn} disabled={locked || dayReadBlocked}
                onChange={(e) => { const value = e.target.value; setForm(current => ({ ...current, checkIn: value })); }}
                className="correction-input" />
            </label>
            <label className="correction-field">
              <span>Check out</span>
              <input type="time" aria-label="Corrected check-out" value={form.checkOut} disabled={locked || dayReadBlocked}
                onChange={(e) => { const value = e.target.value; setForm(current => ({ ...current, checkOut: value })); }}
                className="correction-input" />
            </label>
          </div>

          <label className="correction-check">
            <input type="checkbox" aria-label="Check-out is next day" checked={form.checkOutNextDay} disabled={!form.checkOut || locked || dayReadBlocked}
              onChange={(e) => { const value = e.target.checked; setForm(current => ({ ...current, checkOutNextDay: value })); }} />
            Check-out is next day
          </label>
          <p className="correction-hint">Times are in IST. Select next day for a shift ending after midnight, including a check-out-only correction.</p>

          <label className="correction-field">
            <span>Reason</span>
            <textarea aria-label="Correction reason" required rows={2} value={form.reason} disabled={locked || dayReadBlocked}
              onChange={(e) => { const value = e.target.value; setForm(current => ({ ...current, reason: value })); }}
              placeholder="Face reader did not register on exit"
              className="correction-input" />
          </label>

          <button type="submit" disabled={createBlocked}
            className="correction-submit w-full rounded-xl bg-brand-action text-brand-on hover:bg-brand-action-hover font-bold disabled:opacity-50">
            {create.isPending ? 'Submitting…' : 'Submit for approval'}
          </button>
          </fieldset>
          <p role="status" className="sr-only">{create.isPending ? 'Submitting correction…' : ''}</p>

          {create.isError ? <ErrorNote error={create.error} /> : null}
          {formError ? <p role="alert" className="text-xs text-red-700 dark:text-red-300">{formError}</p> : null}
          {create.isSuccess ? <p className="text-xs text-emerald-600 dark:text-emerald-400">Submitted for approval. Attendance updates after another reviewer approves and the attendance engine processes this day.</p> : null}
          {!onBehalf && !employee?.id ? <p className="text-xs text-amber-600">Your login is not linked to an employee record.</p> : null}
          {target && onBehalf && canReadDay && canBeyondSelf('attendance.read') && <Link className="text-xs text-brand-ink underline" to={`/attendance/person?employee=${encodeURIComponent(target.id)}&period=${encodeURIComponent(form.workDate.slice(0, 7))}`}>Review this employee’s attendance</Link>}
        </form>

        <div className="premium-card paged-collection">
          <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-700 dark:text-neutral-200 mb-2">
            My requests
          </h3>
          {mineError ? <ErrorNote error={mineError} /> : loadingMine ? (
            <SkeletonRows rows={3} compact avatar={false} label="Loading your requests" />
          ) : mine.length === 0 ? (
            <p className="text-xs text-neutral-500">Nothing raised yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {minePager.slice.map((r) => (
                <li key={r.id} {...(reviewing ? rowProps(r.id) : {})} className="mobile-list-row flex items-center justify-between text-xs">
                  <span className="font-mono">{r.work_date}</span>
                  <span className={`badge ${r.status === 'Approved' ? 'badge-green' : r.status === 'Rejected' ? 'bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300' : 'badge-muted'}`}>
                    {r.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Pagination {...minePager} noun="my requests" sizes={[8, 25, 50]} />
        </div>
      </div>

      <div className="lg:col-span-2 min-w-0 space-y-3 paged-collection">
        <div className="premium-card overflow-hidden">
          <div className="p-4 pb-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-700 dark:text-neutral-200">
              {reviewing ? 'Pending approval' : 'My request details'}
            </h3>
            <div className="mt-3">
              <ListSearch value={search} onChange={setSearch} label="Search attendance corrections" placeholder="Search name, code, date or reason…" />
            </div>
          </div>

          {queueError ? <ErrorNote error={queueError} /> : isLoading ? (
            <SkeletonTable rows={5} columns={reviewing ? 6 : 5} label="Loading attendance corrections" />
          ) : matching.length === 0 ? (
            <div className="p-10 text-center text-xs text-neutral-500">{search.trim() ? 'No requests match your search.' : reviewing ? 'Nothing waiting for approval.' : 'No correction requests yet.'}</div>
          ) : (
            <div className="table-scroll">
              <table className="premium-table phone-rows w-full text-xs">
                <thead>
                  <tr>
                    <th className="text-left">Date</th>
                    <th className="text-left">Employee</th>
                    <th className="text-left">Proposed</th>
                    <th className="text-left">Reason</th>
                    <th className="text-left">Status</th>
                    {reviewing ? <th className="text-right">Decision</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {queuePager.slice.map((r) => (
                    <tr key={r.id} {...rowProps(r.id)}>
                      <td data-label="Date" className="font-mono">{r.work_date}</td>
                      <td data-label="Employee">
                        <div className="font-semibold text-neutral-800 dark:text-neutral-100"><EmployeeLink employee={r.employee} /></div>
                        <div className="text-2xs text-neutral-400">{r.employee?.branch?.name ?? ''}</div>
                      </td>
                      <td data-label="Proposed" className="font-mono">{fmtTime(r.check_in)}{correctionDateLabel(r.check_in, r.work_date)} – {fmtTime(r.check_out)}{correctionDateLabel(r.check_out, r.work_date)}</td>
                      <td data-label="Reason" className="max-w-72 whitespace-normal break-words text-neutral-500">{r.reason}</td>
                      <td data-label="Status"><span className={`badge ${r.status === 'Approved' ? 'badge-green' : r.status === 'Rejected' ? 'bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300' : 'badge-muted'}`}>{r.status}</span>
                        {r.decision_note && <p className="mt-1 whitespace-normal break-words text-neutral-500">{r.decision_note}</p>}
                      </td>
                      {reviewing && canDecide(r) ? (
                        <td data-label="Decision" className="text-right whitespace-nowrap">
                          <button
                            onClick={() => decide.mutate({ id: r.id, decision: 'Approved' })}
                            disabled={decide.isPending}
                            className="px-2 py-1 rounded-lg bg-brand-action hover:bg-brand-action-hover text-brand-on text-2xs font-bold mr-1 disabled:opacity-50 cursor-pointer"
                          >
                            Approve
                          </button>
                          {/* Was grey. Grey is the colour of "secondary", not of "no" — the two
                              halves of one decision have to read as opposites, or the reader has
                              to look at the words to tell which is which. */}
                          <button
                            onClick={() => decide.mutate({ id: r.id, decision: 'Rejected' })}
                            disabled={decide.isPending}
                            className="px-2 py-1 rounded-lg border border-red-300 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-950/50 text-2xs font-bold disabled:opacity-50 cursor-pointer"
                          >
                            Reject
                          </button>
                        </td>
                      ) : reviewing ? <td data-label="Decision" className="text-neutral-500">{r.employee_id === employee?.id || r.requested_by === user?.id ? 'Another reviewer must decide' : 'Outside your review scope'}</td> : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {decide.error ? <ErrorNote error={decide.error} /> : null}
        <Pagination {...queuePager} noun={reviewing ? 'pending requests' : 'requests'} disabled={decide.isPending} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function Attendance() {
  const { employee } = useAuth();
  const { canAny, canBeyondSelf, viewingAsEmployee } = usePermissions();
  const [workDate, setWorkDate] = useState(todayIso());
  const [params] = useSearchParams();
  const selfAttendanceMode = viewingAsEmployee || !canBeyondSelf('attendance.read');
  // Phones share one chosen day between the day ring and the month calendar below it.
  const phone = useMediaQuery('(max-width: 640px)');
  const [focusDay, setFocusDay] = useState(todayIso());

  // A `scoped` tab looks at other people, so it needs the permission held beyond your own record.
  // A `self` tab looks only at you, so it belongs to the employee view — see the note on TABS.
  // Someone whose only role IS employee is always viewing as one, so they keep it.
  const visibleTabs = TABS.filter((t) => {
    if (t.self && !selfAttendanceMode) return false;
    return !t.perm || (t.scoped ? canBeyondSelf(t.perm) : canAny(t.perm));
  });

  // Land on — and validate the URL against — only the tabs this person actually has. Without
  // Today, a self-service employee opens on their own month instead of an empty roster board, and
  // typing /attendance/today no longer draws it either.
  // In the URL, so a refresh comes back to the tab you were reading. See lib/useUrlTab.
  const [tab, setTab] = useUrlTab(visibleTabs[0]?.id ?? 'calendar', visibleTabs.map((t) => t.id));
  const canApprove = canAny('regularization.approve');
  const reviewing = canApprove && !viewingAsEmployee;
  const sectionCounts = useSectionCounts({ enabled: reviewing, selfOnly: viewingAsEmployee });
  // Carry the shell's review count through to the tab containing those requests. Attendance
  // exceptions and today's roster are separate views, not additional approval queues.
  const reviewBadge = reviewing ? navigationScreenCount('attendance', sectionCounts.data) : null;
  const showSourceNote = canAny('device.manage');
  // On a phone the views join the section's pills in one row (see SectionTabs); self-service keeps
  // its own layout.
  const mergeViews = phone && !selfAttendanceMode;
  const views = selfAttendanceMode ? undefined : {
    // "By person" is a screen of this section already, so its view does not get a second pill.
    items: visibleTabs.filter((t) => t.id !== 'person').map((t) => ({ id: t.id, label: t.label, shortLabel: t.id === 'regularizations' ? 'Corrections' : undefined,
      badge: t.id === 'regularizations' ? reviewBadge : null })),
    active: tab,
    onSelect: setTab,
  };

  return (
    <div className={`page-shell space-y-5 animate-slide-up py-3 ${selfAttendanceMode ? 'attendance-self-phone' : ''}`}>
      <PageHeader
        title={selfAttendanceMode ? 'My Attendance' : (TAB_TITLES[tab] ?? 'Attendance')}
        subtitle={showSourceNote
          ? 'Sourced from the ZKTeco face terminals via BioTime. Punches sync every couple of minutes and each day is worked out against the assigned shift.'
          : undefined}
        views={views}
      />

      {selfAttendanceMode ? (
        <MyAttendanceHero
          employee={employee}
          onOpenCalendar={() => setTab('calendar')}
          onFixAttendance={() => setTab('regularizations')}
        />
      ) : null}

      {!mergeViews && <nav aria-label="Attendance views" className={`mobile-segmented mobile-segmented-dense attendance-views flex flex-wrap gap-1.5 ${tab === 'calendar' ? '' : 'is-elsewhere'}`}>
        {visibleTabs.map((t) => {
          const Icon = t.icon;
          const label = selfAttendanceMode && t.id === 'regularizations' ? 'Fix attendance' : t.label;
          const badge = t.id === 'regularizations' ? reviewBadge : null;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? 'page' : undefined}
              aria-label={navigationCountLabel(label, badge)}
              className={`drawer-tab flex items-center gap-1.5 ${tab === t.id ? 'drawer-tab-active' : ''}`}
            >
              <Icon size={13} />
              {label}
              <NavigationCountBadge badge={badge} />
            </button>
          );
        })}
      </nav>}

      {tab === 'today' ? (
        <TodayView workDate={workDate} setWorkDate={setWorkDate} />
      ) : null}
      {tab === 'calendar' && selfAttendanceMode && employee?.id
        ? <MyDayPhone employeeId={employee.id} day={focusDay} onDay={setFocusDay}
            onFix={() => setTab('regularizations')} onOverview={() => setTab('overview')} /> : null}
      {tab === 'calendar' ? <CalendarView employeeId={employee?.id} employeeName={employee?.full_name}
        selectedDate={phone && selfAttendanceMode ? focusDay : undefined} onSelectDate={phone && selfAttendanceMode ? setFocusDay : undefined} /> : null}
      {tab === 'person' ? <PersonAttendanceView /> : null}
      {tab === 'overview' ? (
        employee?.id ? <EmployeeAttendanceDetail employee={employee} embedded /> : (
          <div role="status" className="premium-card text-sm text-neutral-500">
            Your login is not linked to an employee record. Contact HR to view your attendance overview.
          </div>
        )
      ) : null}
      {tab === 'exceptions' ? <ExceptionsView /> : null}
      {tab === 'regularizations' ? <RegularizationsView key={`${params.get('employee') ?? ''}:${params.get('date') ?? ''}`} employee={employee} canApprove={canApprove} /> : null}
    </div>
  );
}
