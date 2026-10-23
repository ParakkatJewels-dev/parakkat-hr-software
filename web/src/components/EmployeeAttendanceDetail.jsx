// One person's attendance, in detail.
//
// The day view answers "who is in today" across the company. This answers the question a manager
// actually asks at appraisal time or when signing off payroll: "what does this person's month
// look like, and is there a pattern?"
//
// Everything is filterable by date range and by what happened, because the useful queries are
// specific — "show me only the late days in June" — not "show me everything".
import React, { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  CalendarDays, Clock, AlertTriangle, TrendingUp, ArrowLeft, Download, Search, ChevronRight, ChevronDown, LogIn, Timer, Hourglass, Building2, Pencil,
} from 'lucide-react';
import { useEmployeeAttendanceSummary } from '../data/employeeAttendance';
import { fmtMinutes, fmtTime, monthRange, todayIso } from '../data/attendance';
import { usePermissions } from '../auth/usePermissions';
import { useAuth } from '../auth/AuthContext';
import PunchCorrectionEditor from './PunchCorrectionEditor';
import { formatMinutesOfDay } from '../lib/clock';
import { useClockFormat } from '../lib/timeFormat';
import { explainDay, asHoursMinutes, onSiteMinutes, insideMinutes } from '../lib/attendanceSummary';
import { useEmployees } from '../data/employees';
import PunchTimeline, { BreakSummary } from './ui/PunchTimeline';
import PunchDetails from './ui/PunchDetails';
import { recordedPunches, firstRecordedPunch, latestRecordedPunch, punchDate } from '../lib/recordedPunches';
import { attendanceTimeline } from '../lib/attendanceTimeline';
import { attendanceIssueReasons, attendanceReviewRows } from '../lib/attendanceIssues';
import Pagination, { usePagination } from './ui/Pagination';
import FilterSelect from './ui/FilterSelect';
import DateRangeFilter, { useDateRange } from './ui/DateRangeFilter';
import PageHeader from './ui/PageHeader';
import Avatar from './ui/Avatar';
import { StatCard } from './ui/StatCard';
import StatusPill from './ui/StatusPill';
import FilterSheet, { SheetField } from './ui/FilterSheet';
import { RANGE_PRESETS } from '../lib/dateRange';
import { punchSteps } from '../lib/weekStrip';
import { useMediaQuery } from '../lib/useMediaQuery';
import './attendance/personPicker.css';
import { btnClass } from './ui/Btn';
import { SkeletonRows } from './ui/Skeleton';

const SHOW = [
  { key: 'all', label: 'Every day' },
  { key: 'issues', label: 'Issue dates only' },
  { key: 'late', label: 'Late only' },
  { key: 'absent', label: 'Absent only' },
  { key: 'leave', label: 'Leave only' },
  { key: 'ot', label: 'Overtime only' },
  { key: 'exceptions', label: 'Exceptions' },
];

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const statusTone = (r) =>
  r.status === 'Present' ? 'text-brand-ink dark:text-brand-ink'
  : r.status === 'Absent' ? 'text-rose-600 dark:text-rose-400'
  : r.status === 'On Leave' ? 'text-blue-600 dark:text-blue-400'
  : 'text-neutral-400';

const fmtDate = (d) =>
  new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });

export default function EmployeeAttendanceDetail({ employeeId: fixedId, employee: fixedEmployee, onBack, embedded = false, period, correctDate, onCorrectionStateChange,
  showFilter, onShowChange, payrollAttendance, fromPayroll = false }) {
  const { can, viewingAsEmployee } = usePermissions();
  const { employee: signedInEmployee } = useAuth();
  // Self-service supplies the signed-in employee. It needs neither a directory query
  // nor a person picker, even when the account also holds a management role.
  const { data: employees = [] } = useEmployees({ enabled: !fixedEmployee });
  const [selectedId, setEmployeeId] = useState('');
  const lockedId = fixedEmployee?.id ?? fixedId;
  const employeeId = lockedId ?? selectedId;
  // Defaults to the current month: the period anyone asking about someone's attendance means
  // first, and the one payroll is run against.
  // Subscribed so switching the clock format repaints these times at once.
  const { hour12 } = useClockFormat();
  const range = useDateRange('month');
  const fixedPeriod = /^\d{4}-(0[1-9]|1[0-2])$/.test(period ?? '');
  const { from, to } = fixedPeriod ? monthRange(Number(period.slice(0, 4)), Number(period.slice(5, 7))) : range;
  const [localShow, setLocalShow] = useState('all');
  const show = SHOW.some(option => option.key === showFilter) ? showFilter : localShow;
  const setShow = value => { setLocalShow(value); onShowChange?.(value); };
  const [q, setQ] = useState('');
  // Which day's punch timeline is open. One at a time — the table stays scannable.
  const [openDay, setOpenDay] = useState(null);
  const [correctionDate, setCorrectionDate] = useState(() => /^\d{4}-\d{2}-\d{2}$/.test(correctDate ?? '') && correctDate <= todayIso() ? correctDate : null);
  const [correctionBusy, setCorrectionBusy] = useState(false);
  // "Show" answers what happened; this answers what the day was scored as. They are not the same
  // question — Half Day, Missing Punch and Weekly Off have no entry in SHOW and were unreachable.
  const [status, setStatus] = useState('All statuses');
  const phone = useMediaQuery('(max-width: 640px)');

  const person = fixedEmployee ?? employees.find((e) => e.id === employeeId) ?? null;
  const canCorrect = Boolean(person && can('regularization.create', { entityId: person.entity_id,
    zoneId: person.zone_id, branchId: person.branch_id, deptId: person.department_id, employeeId: person.id }));
  const canEditPunches = Boolean(person && !viewingAsEmployee && person.id !== signedInEmployee?.id
    && can('attendance.manage', { entityId: person.entity_id, zoneId: person.zone_id,
      branchId: person.branch_id, deptId: person.department_id, employeeId: person.id }));
  const showRequestCorrection = canCorrect && !fromPayroll;
  const showCorrection = showRequestCorrection || canEditPunches;
  const correctionStateChange = value => { setCorrectionBusy(value); onCorrectionStateChange?.(value); };
  const { data: rows = [], isLoading, error, refetch, isFetching, summary } = useEmployeeAttendanceSummary(employeeId, from, to);
  const reviewRows = useMemo(() => attendanceReviewRows(rows, { employeeId, from, to, today: todayIso(), payrollAttendance }),
    [rows, employeeId, from, to, payrollAttendance]);
  const issueCount = reviewRows.filter(row => attendanceIssueReasons(row).length > 0).length;

  // Only the statuses this person actually has in the range, so the list never offers a dead end.
  const statusOptions = useMemo(() => {
    const ORDER = ['Present', 'Absent', 'Half Day', 'Missing Punch', 'On Leave', 'No Shift', 'Not processed', 'Weekly Off', 'Holiday'];
    const seen = [...new Set(reviewRows.map((r) => r.status).filter(Boolean))].sort((a, b) => {
      const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
      return (ia === -1 ? ORDER.length : ia) - (ib === -1 ? ORDER.length : ib) || a.localeCompare(b);
    });
    return ['All statuses', ...seen];
  }, [reviewRows]);

  const filtered = useMemo(() => reviewRows.filter((r) => {
    if (status !== 'All statuses' && r.status !== status) return false;
    if (show === 'late' && !r.is_late) return false;
    if (show === 'absent' && r.status !== 'Absent') return false;
    if (show === 'leave' && r.status !== 'On Leave') return false;
    if (show === 'ot' && !(r.ot_minutes > 0)) return false;
    if (show === 'issues' && !attendanceIssueReasons(r).length) return false;
    if (show === 'exceptions' && !(r.is_late || r.is_early_exit || r.is_missing_punch || r.status === 'Absent')) return false;
    return true;
  }), [reviewRows, show, status]);

  const pager = usePagination(filtered, 31, null, `${employeeId}:${from}:${to}:${status}:${show}`);

  // Who to look at. At 242 people a dropdown is unusable, so it is a search.
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    return employees.filter((e) =>
      (e.full_name || '').toLowerCase().includes(t) || (e.employee_code || '').toLowerCase().includes(t)
    );
  }, [employees, q]);
  const peoplePager = usePagination(matches, 8, null, q);

  const exportCsv = () => {
    const head = ['Date', 'Day', 'Status', 'First punch', 'Latest punch', 'Attendance in', 'Attendance out', 'Worked (h)', 'On site (h)', 'Inside (h)', 'Breaks', 'Break (min)',
      'Break complete', 'Late (min)', 'Early (min)', 'OT (min)', 'Leave', 'All punches'];
    const body = filtered.map((r) => {
      const punches = recordedPunches(r);
      const corrected = attendanceTimeline(r);
      const breaks = corrected.length >= 4 ? Math.floor((corrected.length - 2) / 2) : 0;
      return [
        r.work_date, DOW[new Date(`${r.work_date}T00:00:00`).getDay()], r.status,
        fmtTime(firstRecordedPunch(r)), fmtTime(latestRecordedPunch(r)), fmtTime(r.check_in), fmtTime(r.check_out),
        ((r.worked_minutes || 0) / 60).toFixed(2),
        // Same two helpers the table uses, so the exported file and the screen cannot disagree —
        // this column used to recompute the on-site window inline and would have drifted.
        onSiteMinutes(r) != null ? (onSiteMinutes(r) / 60).toFixed(2) : '',
        insideMinutes(r) != null ? (insideMinutes(r) / 60).toFixed(2) : '',
        breaks, r.break_minutes || 0, r.breaks_incomplete ? 'no' : 'yes',
        r.late_minutes || 0, r.early_exit_minutes || 0, r.ot_minutes || 0, r.leave_type || '',
        // Quoted: a space-separated list would otherwise split across columns.
        `"${punches.map((p) => `${punchDate(p)} ${fmtTime(p, hour12)}`).join(' | ')}"`,
      ];
    });
    const csv = [head, ...body].map((line) => line.join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${person?.employee_code || 'attendance'}_${from}_to_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportButton = !error && reviewRows.length > 0 && (
    <button onClick={exportCsv} className={btnClass('ghost')}>
      <Download size={13} /> Export
    </button>
  );

  return (
    <div className={`${embedded ? '' : 'page-shell '}space-y-4 animate-fade-in`}>
      {embedded ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-bold text-neutral-900 dark:text-white">Attendance overview</h2>
          {exportButton}
        </div>
      ) : <PageHeader
        eyebrow="Time & Attendance"
        icon={CalendarDays}
        className="page-header-inline-actions"
        title={person ? person.full_name : 'Attendance detail'}
        subtitle={
          person
            ? [person.employee_code, person.designation?.title, person.branch?.name || person.branch?.code]
                .filter(Boolean).join(' · ')
            : 'Pick a person to see their record.'
        }
        actions={
          <>
            {exportButton}
            {onBack && (
              <button onClick={onBack} className={`${btnClass('ghost')} page-back-button`}>
                <ArrowLeft size={13} /> Back
              </button>
            )}
          </>
        }
      />}

      {/* ---- who ---------------------------------------------------------------------- */}
      {!lockedId && (
        // The search box and its results as one picker (round 3). The search icon used to sit in the
        // middle of the results list, because one wrapper held both the box and the list.
        <div className="premium-card person-picker">
          <label htmlFor="att-person" className="person-picker-label">Find a person</label>
          <div className="person-picker-search">
            <Search size={16} aria-hidden="true" />
            <input
              id="att-person"
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              disabled={correctionBusy}
              autoComplete="off"
              placeholder="Name or employee code…"
            />
          </div>
          {matches.length > 0 && (
            <div className="person-picker-results paged-collection">
              <ul>
                {peoplePager.slice.map((e) => (
                  <li key={e.id}>
                    <button
                      type="button"
                      onClick={() => { if (correctionBusy) return; setEmployeeId(e.id); setQ(''); setCorrectionDate(null); }}
                      disabled={correctionBusy}
                    >
                      <Avatar name={e.full_name} size="md" />
                      <span className="person-picker-who">
                        <strong>{e.full_name}</strong>
                        <em>{[e.employee_code, e.designation?.title, e.branch?.code || e.branch?.name].filter(Boolean).join(' · ')}</em>
                      </span>
                      <ChevronRight size={16} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
              <Pagination {...peoplePager} noun="matching people" sizes={[8, 25, 50]} />
            </div>
          )}
        </div>
      )}

      {!employeeId ? (
        <div className="premium-card p-10 text-center">
          <CalendarDays size={26} className="mx-auto text-neutral-300 dark:text-neutral-700" />
          <p className="text-sm text-neutral-500 mt-2.5">Search for someone above to see their attendance.</p>
        </div>
      ) : (
        <>
          {/* ---- when and what ---------------------------------------------------------- */}
          <div className="premium-card space-y-2.5">
            {(() => {
              const showSelect = <FilterSelect label="Show" value={SHOW.find(option => option.key === show)?.label} options={SHOW.map(option => option.label)} allValue="Every day"
                onChange={label => setShow(SHOW.find(option => option.label === label)?.key || 'all')} />;
              const statusSelect = <FilterSelect label="Status" value={status} options={statusOptions} onChange={setStatus} allValue="All statuses" />;
              const fix = canEditPunches
                ? <button type="button" className={btnClass('ghost', 'sm')} disabled={Boolean(correctionDate)} onClick={() => setCorrectionDate(filtered.find(row => row.work_date <= todayIso() && !row.is_locked)?.work_date || (from > todayIso() ? todayIso() : from))}>Edit punches</button>
                : showRequestCorrection && <Link className={phone ? btnClass('ghost', 'sm') : 'text-xs text-brand-ink underline'} to={`/attendance/regularizations?employee=${encodeURIComponent(employeeId)}&date=${encodeURIComponent(from > todayIso() ? todayIso() : from)}`}>{phone ? 'Request a correction' : 'Request a punch correction'}</Link>;
              // A phone: the dates on top, then Filters (show, status) beside the correction action
              // — the two dropdowns used to stack under the dates in different sizes.
              // A phone: the period as one button (quick ranges and dates in a sheet) beside Filters,
              // and the correction action under them - the five range pills used to take two rows.
              if (phone) {
                const presetLabel = range.preset === 'custom' ? 'Custom dates' : RANGE_PRESETS.find((p) => p.key === range.preset)?.label ?? 'Dates';
                return (
                  <div className="space-y-2.5">
                    <div className="phone-tool-row att-period-row">
                      {fixedPeriod ? <span className="att-period-fixed"><CalendarDays size={16} aria-hidden="true" /> {shortRange(from, to)}</span> : (
                        <FilterSheet title="Which days" label={`${presetLabel} · ${shortRange(from, to)}`} icon={CalendarDays}>
                          <SheetField label="Period" group><DateRangeFilter {...range} /></SheetField>
                        </FilterSheet>
                      )}
                      <FilterSheet title="Filter days" iconOnly count={(show !== 'all' ? 1 : 0) + (status !== 'All statuses' ? 1 : 0)}
                        onClear={() => { setShow('all'); setStatus('All statuses'); }}>
                        {showSelect}
                        {statusSelect}
                      </FilterSheet>
                    </div>
                    {fix && <div className="att-period-fix">{fix}</div>}
                  </div>
                );
              }
              return (
                <div className="mobile-toolbar flex flex-wrap items-center gap-1.5">
                  {fixedPeriod ? <span className="text-sm font-semibold">{from} to {to}</span> : <DateRangeFilter {...range} />}
                  {fix}
                  <span className="sm:ml-auto">{showSelect}</span>
                  <span>{statusSelect}</span>
                </div>
              );
            })()}
            {show === 'issues' && <p className="text-xs text-neutral-500">{issueCount} {issueCount === 1 ? 'date needs' : 'dates need'} review. Showing missing punches, incomplete breaks, missing shifts, invalid credits and unprocessed attendance.</p>}
            {fromPayroll && !canEditPunches && <p className="text-xs text-amber-700 dark:text-amber-300">{person?.id === signedInEmployee?.id
              ? 'Another HR manager must correct your own attendance.'
              : 'You can review these dates, but attendance management permission is required to edit this employee’s punches.'}</p>}
            {fromPayroll && Number(payrollAttendance?.pending_recompute_days) > 0 && <p role="status" className="text-xs text-neutral-500">Saved attendance changes are waiting to be processed. The issue dates and payroll hours will refresh after processing.</p>}
          </div>

          {canEditPunches && correctionDate && <PunchCorrectionEditor key={`${employeeId}:${correctionDate}`} employee={person} workDate={correctionDate}
            onStateChange={correctionStateChange} onClose={() => { setCorrectionDate(null); correctionStateChange(false); }} />}

          {error ? (
            <div role="alert" className="premium-card space-y-2">
              <p className="text-sm text-red-700 dark:text-red-300">Couldn’t load attendance. Please try again.</p>
              <button type="button" onClick={() => refetch()} disabled={isFetching} className={btnClass('ghost')}>
                {isFetching ? 'Retrying…' : 'Try again'}
              </button>
            </div>
          ) : isLoading ? (
            <div className="premium-card"><SkeletonRows rows={6} /></div>
          ) : (
            <>
              {/* ---- the numbers --------------------------------------------------------- */}
              {show !== 'issues' && <>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                {/* Each sub-line states the arithmetic behind the number above it. They drifted
                    apart once before — the rate counted half days as half while the caption
                    counted only whole ones — and a percentage nobody can reconcile is worse than
                    no percentage. */}
                <Stat label="Attendance" value={summary.attendanceRate != null ? `${summary.attendanceRate}%` : '—'}
                  sub={summary.halfDays
                    ? `${summary.present} full + ${summary.halfDays} half of ${summary.workingDays} working days`
                    : `${summary.present} of ${summary.workingDays} working days`}
                  tone="green" icon={TrendingUp} />
                {/* A flexible shift has no start time to be late for, so punctuality would read
                    100% for everyone forever. What is owed there is the daily hours, so that is
                    what gets measured. */}
                {summary.flexible ? (
                  <Stat label="Hours completed" icon={Hourglass} value={summary.hoursMetRate != null ? `${summary.hoursMetRate}%` : '—'}
                    sub={`${summary.shortDays} short of ${summary.attended} ${summary.attended === 1 ? 'day' : 'days'} attended`}
                    tone={summary.hoursMetRate != null && summary.hoursMetRate < 85 ? 'amber' : 'green'} icon={Clock} />
                ) : (
                  <Stat label="Punctuality" value={summary.punctualityRate != null ? `${summary.punctualityRate}%` : '—'}
                    sub={`${summary.lateDays} late of ${summary.attended} ${summary.attended === 1 ? 'day' : 'days'} attended`}
                    tone={summary.punctualityRate != null && summary.punctualityRate < 85 ? 'amber' : 'green'} icon={Clock} />
                )}
                <Stat label="Avg arrival" icon={LogIn} value={formatMinutesOfDay(summary.avgArrival, hour12)}
                  sub={summary.flexible
                    ? 'no fixed start on this shift'
                    : summary.avgLatePerLateDay ? `${summary.avgLatePerLateDay} min late when late` : 'on time'} />
                {/* Three figures that visibly add up, rather than two that might.
                    "Total hours, of which some is overtime" kept reading as though the overtime
                    was extra on top. Regular and Overtime are disjoint, Total is their sum, and
                    nobody has to work out which contains which. */}
                <Stat label="Regular hours" icon={Clock} value={fmtMinutes(summary.normalMinutes)}
                  sub="not counting overtime" />
                {/* "plus N h on days off" was accurate only while the total excluded them. Now
                    that it does not, "plus" would read as extra on top and count Sunday twice. */}
                <Stat label="Overtime" icon={Timer} value={fmtMinutes(summary.otMinutes)}
                  sub={summary.offDayOtHours
                    ? `includes ${fmtMinutes(summary.offDayOtMinutes)} worked on days off`
                    : 'beyond a full day'}
                  tone={summary.otHours > 0 ? 'green' : undefined} />
                {/* Two figures, because they answer two questions and only one of them was on the
                    page. "Total hours" is what gets paid — it contains the break allowance, so a
                    day spent inside for 8 hours with an hour's lunch is credited 8h40m. "Inside"
                    is what the clock actually saw. Showing only the payable number left "how long
                    was I really here" unanswerable without adding up the punches by hand. */}
                <Stat label="Total hours" icon={Hourglass} value={fmtMinutes(summary.workedMinutes)}
                  sub={`${fmtMinutes(summary.normalMinutes)} + ${fmtMinutes(summary.otMinutes)}`} tone="green" />
                {/* The sub-line must never be workedHours - insideHours. Those two are totalled over
                    different sets of days whenever anything is unmeasurable, and the difference then
                    reads as break allowance that nobody took — 90.8 h of it for a person whose every
                    day was single-punch. summarise() now derives the allowance over the measured days
                    only, and counts the rest so the tile can admit what it cannot see. */}
                <Stat label="Inside" icon={Building2} value={`${summary.insideHours} h`}
                  sub={
                    summary.unmeasuredDays > 0
                      ? `${summary.unmeasuredDays} day${summary.unmeasuredDays === 1 ? '' : 's'} not measurable`
                      : summary.insideAllowanceHours > 0
                        ? `${summary.insideAllowanceHours} h break allowance`
                        : 'never left the building'
                  }
                  tone={summary.unmeasuredDays > 0 ? 'amber' : undefined} />
                <Stat label="Exceptions" value={summary.missing + summary.earlyDays}
                  sub={`${summary.missing} missing punch · ${summary.earlyDays} early`}
                  tone={summary.missing + summary.earlyDays > 0 ? 'amber' : undefined} icon={AlertTriangle} />
              </div>

              {/* ---- pattern by weekday -------------------------------------------------- */}
              {summary.workingDays > 0 && (
                <div className="premium-card">
                  <p className="text-2xs font-bold uppercase tracking-wider text-neutral-450 mb-2">
                    {summary.flexible ? 'Short days by weekday' : 'Lateness by weekday'}
                  </p>
                  <div className="flex items-end gap-2">
                    {summary.byDow.map((d, i) => {
                      const n = summary.flexible ? d.short : d.late;
                      const pct = d.total ? Math.round((n / d.total) * 100) : 0;
                      return (
                        <div key={i} className="flex-1 text-center">
                          <div className="h-16 flex items-end justify-center">
                            <div
                              className={`w-full rounded-t ${pct > 40 ? 'bg-amber-500' : 'bg-brand-action'}`}
                              style={{ height: `${Math.max(pct, d.total ? 4 : 0)}%` }}
                              title={`${n} of ${d.total} ${summary.flexible ? 'short of the hours' : 'late'}`}
                            />
                          </div>
                          <p className="text-2xs text-neutral-500 mt-1">{DOW[i]}</p>
                          <p className="text-2xs font-bold tabular-nums text-neutral-700 dark:text-neutral-300">
                            {d.total ? `${pct}%` : '—'}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              </>}

              {/* ---- the days ------------------------------------------------------------ */}
              {/* A phone: one line per day (round 3) - the date as a tile, in and out with what
                  the day added up to, and the status - and a tap for the punches, the arithmetic
                  and the correction. It was a 13-row label/value card per day. */}
              {phone ? (
                <ul className="premium-card att-days" aria-label="Days">
                  {pager.slice.map((r) => {
                    const punches = attendanceTimeline(r);
                    const open = openDay === r.id;
                    const first = firstRecordedPunch(r);
                    const last = latestRecordedPunch(r);
                    const canCorrectDay = showCorrection && !r.is_locked && r.work_date <= todayIso();
                    const expandable = punches.length > 0 || canCorrectDay || r.is_locked;
                    const facts = [
                      r.worked_minutes ? `Worked ${asHoursMinutes(r.worked_minutes)}` : null,
                      r.late_minutes ? `Late ${r.late_minutes}m` : null,
                      r.ot_minutes ? `OT ${r.ot_minutes}m` : null,
                      r.leave_type || null,
                    ].filter(Boolean);
                    return (
                      <li key={r.id} className={`att-day ${open ? 'is-open' : ''}`}>
                        <button type="button" className="att-day-row" aria-expanded={expandable ? open : undefined}
                          onClick={expandable ? () => setOpenDay(open ? null : r.id) : undefined}>
                          <span className="att-day-date" data-today={r.work_date === todayIso() || undefined}>
                            <em>{DOW[new Date(`${r.work_date}T00:00:00`).getDay()]}</em>
                            <strong>{Number(r.work_date.slice(8))}</strong>
                          </span>
                          <span className="att-day-main">
                            <strong>{first ? `${fmtTime(first)} – ${last && last !== first ? fmtTime(last) : '…'}` : 'No punches'}</strong>
                            <em>{facts.length ? facts.join(' · ') : fmtDate(r.work_date)}</em>
                            {r.is_missing_punch && <span className="att-day-flag">Review punches</span>}
                            {show === 'issues' && <span className="att-day-flag">{attendanceIssueReasons(r).join(' · ')}</span>}
                          </span>
                          <StatusPill status={r.is_late && r.status === 'Present' ? 'Late' : r.status} />
                          {expandable && <ChevronDown size={16} className="att-day-caret" aria-hidden="true" />}
                        </button>
                        {open && (
                          <div className="att-day-more">
                            {punches.length > 0 && <DaySteps punches={punches} incomplete={r.breaks_incomplete} />}
                            {punches.length > 0 && (
                              <details className="att-day-math">
                                <summary>How the hours add up <ChevronDown size={14} aria-hidden="true" /></summary>
                                <DayBreakdown row={r} />
                              </details>
                            )}
                            {r.is_locked ? <p className="att-day-note">Published payroll · this day is locked</p>
                              : canCorrectDay && (canEditPunches
                                ? <button type="button" className="att-day-fix" disabled={correctionBusy} onClick={() => { if (!correctionBusy) setCorrectionDate(r.work_date); }}>
                                    <Pencil size={15} aria-hidden="true" /> Edit punches for {fmtDate(r.work_date)}
                                  </button>
                                : <Link className="att-day-fix" to={`/attendance/regularizations?employee=${encodeURIComponent(employeeId)}&date=${encodeURIComponent(r.work_date)}`}>
                                    <Pencil size={15} aria-hidden="true" /> Correct times for {fmtDate(r.work_date)}
                                  </Link>)}
                          </div>
                        )}
                      </li>
                    );
                  })}
                  {filtered.length === 0 && (
                    <li className="att-day-empty">
                      {show === 'issues'
                        ? (status === 'All statuses' ? 'No issue dates in this range.' : 'No issue dates match this status.')
                        : reviewRows.length === 0
                        ? 'No attendance recorded in this range.'
                        : `No ${SHOW.find((s) => s.key === show)?.label.toLowerCase()} in this range.`}
                    </li>
                  )}
                </ul>
              ) : (
              <div className="premium-card p-0 overflow-hidden">
                <div className="table-scroll">
                  <table className="premium-table">
                    <thead>
                      <tr>
                        <th className="w-24">Date</th>
                        <th className="w-14">Day</th>
                        <th>Status</th>
                        <th>First punch</th>
                        <th>Latest punch</th>
                        <th>Punches</th>
                        <th className="hidden sm:table-cell" title="Payable hours: time on site less any break beyond the allowance">
                          Worked
                        </th>
                        <th className="hidden md:table-cell" title="First punch to last punch — the whole day, break included">
                          On site
                        </th>
                        <th className="hidden lg:table-cell" title="Time actually in the building: the day less every minute punched out. Lower than Worked, because the first 40 minutes of break are free.">
                          Inside
                        </th>
                        <th className="hidden lg:table-cell" title="Breaks taken, and total time out of office">
                          Breaks
                        </th>
                        <th className="hidden md:table-cell">Late</th>
                        <th className="hidden md:table-cell">OT</th>
                        {showCorrection && <th>Correction</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {pager.slice.map((r) => {
                        const dow = new Date(`${r.work_date}T00:00:00`).getDay();
                        const punches = attendanceTimeline(r);
                        // Even a single punch has a recorded time worth inspecting.
                        const hasTimeline = punches.length > 0;
                        const open = openDay === r.id;
                        // Device times plus approved corrections. Schedule reconstructions are
                        // excluded: they have not been verified by an attendance reviewer.
                        const onSite = onSiteMinutes(r);
                        const inside = insideMinutes(r);
                        return (
                          <React.Fragment key={r.id}>
                          <tr
                            className={hasTimeline ? 'cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800/40' : ''}
                            onClick={hasTimeline ? () => setOpenDay(open ? null : r.id) : undefined}>
                            <td data-label="Date" className="font-semibold text-neutral-900 dark:text-white">{fmtDate(r.work_date)}</td>
                            <td data-label="Day" className="text-neutral-450 text-xs">{DOW[dow]}</td>
                            <td data-label="Status" className={`font-semibold ${statusTone(r)}`}>
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span>
                                  {r.status}
                                  {r.leave_type && <span className="text-neutral-450 font-normal"> · {r.leave_type}</span>}
                                  {r.is_missing_punch && <span className="ml-1.5 text-2xs text-amber-600 dark:text-amber-400">review punches</span>}
                                </span>
                              </div>
                              {show === 'issues' && <p className="mt-1 text-2xs font-normal text-amber-700 dark:text-amber-300">{attendanceIssueReasons(r).join(' · ')}</p>}
                            </td>
                            <td data-label="First punch" className={`font-mono ${r.is_late ? 'text-amber-600 dark:text-amber-400' : ''}`}>
                              {fmtTime(firstRecordedPunch(r))}
                            </td>
                            <td data-label="Latest punch" className={`font-mono ${r.is_early_exit ? 'text-amber-600 dark:text-amber-400' : ''}`}>
                              {fmtTime(latestRecordedPunch(r))}
                            </td>
                            <td data-label="Punches"><PunchDetails row={r} /></td>
                            <td data-label="Payable" className="hidden sm:table-cell tabular-nums">
                              {r.worked_minutes ? `${(r.worked_minutes / 60).toFixed(1)} h` : '—'}
                            </td>
                            {/* The whole day, break included. Worked is the payable figure and it
                                already contains the break when that break sat inside the
                                allowance — so on its own it reads as though nobody ever stopped.
                                Side by side with Breaks, these three account for each other. */}
                            <td data-label="Worked" className="hidden md:table-cell tabular-nums text-neutral-500 dark:text-neutral-400">
                              {onSite != null ? `${(onSite / 60).toFixed(1)} h` : '—'}
                            </td>
                            {/* What the clock saw them inside for. Worked is the payable figure and
                                sits above it by however much of the break allowance was forgiven —
                                a 60-minute lunch is 8h inside and 8h40m worked. Both are true; the
                                screen used to show only the payable one, so "how long was I
                                actually here" had no answer on the page. */}
                            <td data-label="Actual" className="hidden lg:table-cell tabular-nums text-neutral-500 dark:text-neutral-400">
                              {inside != null ? `${(inside / 60).toFixed(1)} h` : '—'}
                            </td>
                            <td data-label="Breaks" className="hidden lg:table-cell tabular-nums text-xs">
                              <BreakSummary row={r} />
                            </td>
                            <td data-label="Late" className="hidden md:table-cell tabular-nums text-amber-600 dark:text-amber-400">
                              {r.late_minutes ? `${r.late_minutes}m` : '—'}
                            </td>
                            <td data-label="OT" className="hidden md:table-cell tabular-nums text-brand-ink dark:text-brand-ink">
                              {r.ot_minutes ? `${r.ot_minutes}m` : '—'}
                            </td>
                            {showCorrection && <td data-label="Correction">{r.is_locked
                              ? <span className="text-xs text-neutral-500">Published · locked</span>
                              : r.work_date <= todayIso() && (canEditPunches
                                ? <button type="button" disabled={correctionBusy} onClick={event => { event.stopPropagation(); if (!correctionBusy) setCorrectionDate(r.work_date); }} className="inline-flex min-h-6 items-center text-xs text-brand-ink underline whitespace-nowrap disabled:opacity-50">Edit punches</button>
                                : <Link onClick={event => event.stopPropagation()} className="text-xs text-brand-ink underline whitespace-nowrap" to={`/attendance/regularizations?employee=${encodeURIComponent(employeeId)}&date=${encodeURIComponent(r.work_date)}`}>Correct times</Link>)}</td>}
                          </tr>
                          {open && (
                            <tr>
                              <td colSpan={showCorrection ? 13 : 12} className="bg-neutral-50 dark:bg-neutral-900/50 px-3 py-2.5">
                                <PunchTimeline
                                  punches={punches}
                                  breakMinutes={r.break_minutes}
                                  incomplete={r.breaks_incomplete}
                                />
                                <DayBreakdown row={r} />
                              </td>
                            </tr>
                          )}
                          </React.Fragment>
                        );
                      })}
                      {filtered.length === 0 && (
                        <tr>
                          <td colSpan={showCorrection ? 13 : 12} className="py-8 text-center text-sm text-neutral-500">
                            {show === 'issues'
                              ? (status === 'All statuses' ? 'No issue dates in this range.' : 'No issue dates match this status.')
                              : reviewRows.length === 0
                              ? 'No attendance recorded in this range.'
                              : `No ${SHOW.find((s) => s.key === show)?.label.toLowerCase()} in this range.`}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
              )}

              <Pagination {...pager} noun="days" sizes={[31, 62, 93, 366]} />
            </>
          )}
        </>
      )}
    </div>
  );
}


const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "1 – 23 Oct", "28 Sep – 3 Oct": the period on its button. */
function shortRange(from, to) {
  const [fy, fm, fd] = String(from).split('-').map(Number);
  const [ty, tm, td] = String(to).split('-').map(Number);
  if (!fy || !ty) return `${from} – ${to}`;
  const day = (m, d) => `${d} ${MONTH_SHORT[m - 1]}`;
  if (from === to) return day(fm, fd);
  if (fy === ty && fm === tm) return `${fd} – ${day(tm, td)}`;
  return `${day(fm, fd)} – ${day(tm, td)}${fy !== ty ? ` ${ty}` : ''}`;
}

/** A day's punches on a phone, top to bottom: the time, what it was, and how long until the next
 *  punch - work in plain text, breaks in amber. The computer's bar chart squeezed eight times onto
 *  a 250px line and stacked them over each other. */
function DaySteps({ punches, incomplete }) {
  const steps = punchSteps(punches);
  return (
    <ol className="att-steps" aria-label="Punches">
      {steps.map((step, i) => {
        const next = steps[i + 1];
        const minutes = next ? Math.round((Date.parse(next.at) - Date.parse(step.at)) / 60000) : null;
        const away = step.label === 'Break';
        return (
          <li key={`${step.at}-${i}`} data-kind={i === 0 ? 'in' : step.label === 'Checked out' ? 'out' : away ? 'away' : 'back'}>
            <time>{fmtTime(step.at)}</time>
            <span>{step.label}</span>
            {Number.isFinite(minutes) && minutes > 0 && <em data-away={away || undefined}>{asHoursMinutes(minutes)}</em>}
          </li>
        );
      })}
      {incomplete && <li data-kind="missing"><time>--:--</time><span>Punch missing</span></li>}
    </ol>
  );
}

/** The subtraction, spelled out. A day reading "in 09:37, out 18:51, overtime 5m" is arithmetically
 *  right and impossible to check: the 79 minutes of break that account for the difference are
 *  nowhere on the row. */
function DayBreakdown({ row: r }) {
  const x = explainDay(r, r.shift);
  if (!x) return null;
  return (
    <div className="mt-3 pt-2.5 border-t border-neutral-200 dark:border-neutral-800">
      <dl className="max-w-md space-y-0.5">
        {x.lines.map((l, i) => (
          <div
            key={i}
            className={`flex items-baseline justify-between gap-3 text-2xs ${
              l.total ? 'font-semibold text-neutral-900 dark:text-white pt-0.5' : ''
            } ${l.muted ? 'text-neutral-450' : 'text-neutral-600 dark:text-neutral-300'}`}
          >
            <dt className={l.total ? 'border-t border-neutral-200 dark:border-neutral-800 pt-1 flex-1' : 'flex-1'}>
              {l.label}
            </dt>
            <dd className={`tabular-nums shrink-0 ${l.total ? 'border-t border-neutral-200 dark:border-neutral-800 pt-1' : ''}`}>
              {l.minutes === null ? '?' : asHoursMinutes(l.minutes)}
            </dd>
          </div>
        ))}
      </dl>
      {x.note && (
        <p className={`mt-1.5 text-2xs max-w-md ${
          x.incomplete
            ? 'text-amber-700 dark:text-amber-400 font-medium'
            : 'text-amber-700 dark:text-amber-400'
        }`}>
          {x.note}
        </p>
      )}
    </div>
  );
}

/** A figure for this person's period, as the app's number card (it was an older card with a tiny
 *  uppercase label). */
function Stat({ label, value, sub, tone, icon }) {
  return <StatCard icon={icon} tone={tone === 'green' || tone === 'amber' ? tone : 'slate'} label={label} value={value} sub={sub} />;
}
