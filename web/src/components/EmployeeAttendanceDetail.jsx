// One person's attendance, in detail.
//
// The day view answers "who is in today" across the company. This answers the question a manager
// actually asks at appraisal time or when signing off payroll: "what does this person's month
// look like, and is there a pattern?"
//
// Everything is filterable by date range and by what happened, because the useful queries are
// specific — "show me only the late days in June" — not "show me everything".
import React, { useState, useMemo } from 'react';
import {
  CalendarDays, Clock, AlertTriangle, TrendingUp, ArrowLeft, Download, Search,
} from 'lucide-react';
import { useEmployeeAttendanceSummary } from '../data/employeeAttendance';
import { fmtMinutes, fmtTime } from '../data/attendance';
import { formatMinutesOfDay } from '../lib/clock';
import { useClockFormat } from '../lib/timeFormat';
import { explainDay, asHoursMinutes, onSiteMinutes, insideMinutes } from '../lib/attendanceSummary';
import { useEmployees } from '../data/employees';
import PunchTimeline, { BreakSummary } from './ui/PunchTimeline';
import Pagination, { usePagination } from './ui/Pagination';
import FilterSelect from './ui/FilterSelect';
import DateRangeFilter, { useDateRange } from './ui/DateRangeFilter';
import PageHeader from './ui/PageHeader';
import { btnClass } from './ui/Btn';
import { SkeletonRows } from './ui/Skeleton';

const SHOW = [
  { key: 'all', label: 'Every day' },
  { key: 'late', label: 'Late only' },
  { key: 'absent', label: 'Absent only' },
  { key: 'leave', label: 'Leave only' },
  { key: 'ot', label: 'Overtime only' },
  { key: 'exceptions', label: 'Exceptions' },
];

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const statusTone = (r) =>
  r.status === 'Present' ? 'text-[#0c9765] dark:text-[#10b981]'
  : r.status === 'Absent' ? 'text-rose-600 dark:text-rose-400'
  : r.status === 'On Leave' ? 'text-blue-600 dark:text-blue-400'
  : 'text-neutral-400';

const fmtDate = (d) =>
  new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });

export default function EmployeeAttendanceDetail({ employeeId: fixedId, onBack }) {
  const { data: employees = [] } = useEmployees();
  const [employeeId, setEmployeeId] = useState(fixedId ?? '');
  // Defaults to the current month: the period anyone asking about someone's attendance means
  // first, and the one payroll is run against.
  // Subscribed so switching the clock format repaints these times at once.
  const { hour12 } = useClockFormat();
  const range = useDateRange('month');
  const { from, to } = range;
  const [show, setShow] = useState('all');
  const [q, setQ] = useState('');
  // Which day's punch timeline is open. One at a time — the table stays scannable.
  const [openDay, setOpenDay] = useState(null);
  // "Show" answers what happened; this answers what the day was scored as. They are not the same
  // question — Half Day, Missing Punch and Weekly Off have no entry in SHOW and were unreachable.
  const [status, setStatus] = useState('All statuses');

  const person = employees.find((e) => e.id === employeeId) ?? null;
  const { data: rows = [], isLoading, summary } = useEmployeeAttendanceSummary(employeeId, from, to);

  // Only the statuses this person actually has in the range, so the list never offers a dead end.
  const statusOptions = useMemo(() => {
    const ORDER = ['Present', 'Absent', 'Half Day', 'Missing Punch', 'On Leave', 'No Shift', 'Weekly Off', 'Holiday'];
    const seen = [...new Set(rows.map((r) => r.status).filter(Boolean))].sort((a, b) => {
      const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
      return (ia === -1 ? ORDER.length : ia) - (ib === -1 ? ORDER.length : ib) || a.localeCompare(b);
    });
    return ['All statuses', ...seen];
  }, [rows]);

  const filtered = useMemo(() => rows.filter((r) => {
    if (status !== 'All statuses' && r.status !== status) return false;
    if (show === 'late' && !r.is_late) return false;
    if (show === 'absent' && r.status !== 'Absent') return false;
    if (show === 'leave' && r.status !== 'On Leave') return false;
    if (show === 'ot' && !(r.ot_minutes > 0)) return false;
    if (show === 'exceptions' && !(r.is_late || r.is_early_exit || r.is_missing_punch || r.status === 'Absent')) return false;
    return true;
  }), [rows, show, status]);

  const pager = usePagination(filtered, 31);

  // Who to look at. At 242 people a dropdown is unusable, so it is a search.
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    return employees.filter((e) =>
      (e.full_name || '').toLowerCase().includes(t) || (e.employee_code || '').toLowerCase().includes(t)
    ).slice(0, 8);
  }, [employees, q]);

  const exportCsv = () => {
    const head = ['Date', 'Day', 'Status', 'In', 'Out', 'Worked (h)', 'On site (h)', 'Inside (h)', 'Breaks', 'Break (min)',
      'Break complete', 'Late (min)', 'Early (min)', 'OT (min)', 'Leave', 'All punches'];
    const body = filtered.map((r) => {
      const punches = Array.isArray(r.punches) ? r.punches : [];
      const breaks = punches.length >= 4 ? Math.floor((punches.length - 2) / 2) : 0;
      return [
        r.work_date, DOW[new Date(`${r.work_date}T00:00:00`).getDay()], r.status,
        fmtTime(r.check_in), fmtTime(r.check_out),
        ((r.worked_minutes || 0) / 60).toFixed(2),
        // Same two helpers the table uses, so the exported file and the screen cannot disagree —
        // this column used to recompute the on-site window inline and would have drifted.
        onSiteMinutes(r) != null ? (onSiteMinutes(r) / 60).toFixed(2) : '',
        insideMinutes(r) != null ? (insideMinutes(r) / 60).toFixed(2) : '',
        breaks, r.break_minutes || 0, r.breaks_incomplete ? 'no' : 'yes',
        r.late_minutes || 0, r.early_exit_minutes || 0, r.ot_minutes || 0, r.leave_type || '',
        // Quoted: a space-separated list would otherwise split across columns.
        `"${punches.map((p) => fmtTime(p, hour12)).join(' ')}"`,
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

  return (
    <div className="page-shell space-y-4 animate-fade-in">
      <PageHeader
        eyebrow="Time & Attendance"
        icon={CalendarDays}
        title={person ? person.full_name : 'Attendance detail'}
        subtitle={
          person
            ? [person.employee_code, person.designation?.title, person.branch?.name || person.branch?.code]
                .filter(Boolean).join(' · ')
            : 'Pick a person to see their record.'
        }
        actions={
          <>
            {rows.length > 0 && (
              <button onClick={exportCsv} className={btnClass('ghost')}>
                <Download size={13} /> Export
              </button>
            )}
            {onBack && (
              <button onClick={onBack} className={btnClass('ghost')}>
                <ArrowLeft size={13} /> Back
              </button>
            )}
          </>
        }
      />

      {/* ---- who ---------------------------------------------------------------------- */}
      {!fixedId && (
        <div className="premium-card">
          <label htmlFor="att-person" className="block text-2xs font-bold uppercase tracking-wider text-neutral-450 mb-1">
            Person
          </label>
          <div className="relative max-w-md">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              id="att-person"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name or employee code…"
              className="w-full text-sm rounded-lg pl-8 pr-3 py-2 bg-neutral-50 dark:bg-charcoal-900 border border-neutral-200 dark:border-neutral-800 focus:outline-none focus:border-[#0ea971] focus:ring-2 focus:ring-[#0ea971]/20"
            />
            {matches.length > 0 && (
              <ul className="absolute z-20 mt-1 w-full rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-charcoal-900 shadow-2xl overflow-hidden">
                {matches.map((e) => (
                  <li key={e.id}>
                    <button
                      onClick={() => { setEmployeeId(e.id); setQ(''); }}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-charcoal-800 flex justify-between gap-2 cursor-pointer"
                    >
                      <span className="font-semibold truncate">{e.full_name}</span>
                      <span className="text-2xs font-mono text-neutral-450 shrink-0">{e.employee_code}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
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
            <div className="mobile-toolbar flex flex-wrap items-center gap-1.5">
              <DateRangeFilter {...range} />
              <span className="sm:ml-auto">
                <FilterSelect label="Show" value={show} options={SHOW.map((s) => s.key)} allValue="all"
                  onChange={setShow} />
              </span>
              <span>
                <FilterSelect label="Status" value={status} options={statusOptions}
                  onChange={setStatus} allValue="All statuses" />
              </span>
            </div>
          </div>

          {isLoading ? (
            <div className="premium-card"><SkeletonRows rows={6} /></div>
          ) : (
            <>
              {/* ---- the numbers --------------------------------------------------------- */}
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
                  <Stat label="Hours completed" value={summary.hoursMetRate != null ? `${summary.hoursMetRate}%` : '—'}
                    sub={`${summary.shortDays} short of ${summary.attended} ${summary.attended === 1 ? 'day' : 'days'} attended`}
                    tone={summary.hoursMetRate != null && summary.hoursMetRate < 85 ? 'amber' : 'green'} icon={Clock} />
                ) : (
                  <Stat label="Punctuality" value={summary.punctualityRate != null ? `${summary.punctualityRate}%` : '—'}
                    sub={`${summary.lateDays} late of ${summary.attended} ${summary.attended === 1 ? 'day' : 'days'} attended`}
                    tone={summary.punctualityRate != null && summary.punctualityRate < 85 ? 'amber' : 'green'} icon={Clock} />
                )}
                <Stat label="Avg arrival" value={formatMinutesOfDay(summary.avgArrival, hour12)}
                  sub={summary.flexible
                    ? 'no fixed start on this shift'
                    : summary.avgLatePerLateDay ? `${summary.avgLatePerLateDay} min late when late` : 'on time'} />
                {/* Three figures that visibly add up, rather than two that might.
                    "Total hours, of which some is overtime" kept reading as though the overtime
                    was extra on top. Regular and Overtime are disjoint, Total is their sum, and
                    nobody has to work out which contains which. */}
                <Stat label="Regular hours" value={fmtMinutes(summary.normalMinutes)}
                  sub="not counting overtime" />
                {/* "plus N h on days off" was accurate only while the total excluded them. Now
                    that it does not, "plus" would read as extra on top and count Sunday twice. */}
                <Stat label="Overtime" value={fmtMinutes(summary.otMinutes)}
                  sub={summary.offDayOtHours
                    ? `includes ${fmtMinutes(summary.offDayOtMinutes)} worked on days off`
                    : 'beyond a full day'}
                  tone={summary.otHours > 0 ? 'green' : undefined} />
                {/* Two figures, because they answer two questions and only one of them was on the
                    page. "Total hours" is what gets paid — it contains the break allowance, so a
                    day spent inside for 8 hours with an hour's lunch is credited 8h40m. "Inside"
                    is what the clock actually saw. Showing only the payable number left "how long
                    was I really here" unanswerable without adding up the punches by hand. */}
                <Stat label="Total hours" value={fmtMinutes(summary.workedMinutes)}
                  sub={`${fmtMinutes(summary.normalMinutes)} + ${fmtMinutes(summary.otMinutes)}`} tone="green" />
                {/* The sub-line must never be workedHours - insideHours. Those two are totalled over
                    different sets of days whenever anything is unmeasurable, and the difference then
                    reads as break allowance that nobody took — 90.8 h of it for a person whose every
                    day was single-punch. summarise() now derives the allowance over the measured days
                    only, and counts the rest so the tile can admit what it cannot see. */}
                <Stat label="Inside" value={`${summary.insideHours} h`}
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
                              className={`w-full rounded-t ${pct > 40 ? 'bg-amber-500' : 'bg-[#0ea971]'}`}
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

              {/* ---- the days ------------------------------------------------------------ */}
              <div className="premium-card p-0 overflow-hidden">
                <div className="table-scroll">
                  <table className="premium-table">
                    <thead>
                      <tr>
                        <th className="w-24">Date</th>
                        <th className="w-14">Day</th>
                        <th>Status</th>
                        <th>In</th>
                        <th>Out</th>
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
                      </tr>
                    </thead>
                    <tbody>
                      {pager.slice.map((r) => {
                        const dow = new Date(`${r.work_date}T00:00:00`).getDay();
                        const punches = Array.isArray(r.punches) ? r.punches : [];
                        // Two punches are just in and out — there is no timeline worth opening.
                        const hasTimeline = punches.length > 2;
                        const open = openDay === r.id;
                        // First punch to last. Not check_in/check_out: on a day with a
                        // reconstructed punch those are the assumed times, and this column is meant
                        // to be only what the terminal actually recorded.
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
                                  {r.is_missing_punch && <span className="ml-1.5 text-2xs text-amber-600 dark:text-amber-400">no punch out</span>}
                                </span>
                              </div>
                            </td>
                            <td data-label="In" className={`font-mono ${r.is_late ? 'text-amber-600 dark:text-amber-400' : ''}`}>
                              {fmtTime(r.check_in)}
                            </td>
                            <td data-label="Out" className={`font-mono ${r.is_early_exit ? 'text-amber-600 dark:text-amber-400' : ''}`}>
                              {fmtTime(r.check_out)}
                            </td>
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
                            <td data-label="OT" className="hidden md:table-cell tabular-nums text-[#0c9765] dark:text-[#10b981]">
                              {r.ot_minutes ? `${r.ot_minutes}m` : '—'}
                            </td>
                          </tr>
                          {open && (
                            <tr>
                              <td colSpan={10} className="bg-neutral-50 dark:bg-neutral-900/50 px-3 py-2.5">
                                <PunchTimeline
                                  punches={punches}
                                  breakMinutes={r.break_minutes}
                                  incomplete={r.breaks_incomplete}
                                />
                                {/* The subtraction, spelled out. A day reading "in 09:37, out 18:51,
                                    overtime 5m" is arithmetically right and impossible to check:
                                    the 79 minutes of break that account for the difference are
                                    nowhere on the row. */}
                                {(() => {
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
                                })()}
                              </td>
                            </tr>
                          )}
                          </React.Fragment>
                        );
                      })}
                      {filtered.length === 0 && (
                        <tr>
                          <td colSpan={10} className="py-8 text-center text-sm text-neutral-500">
                            {rows.length === 0
                              ? 'No attendance recorded in this range.'
                              : `No ${SHOW.find((s) => s.key === show)?.label.toLowerCase()} in this range.`}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <Pagination {...pager} noun="days" sizes={[31, 62, 93, 366]} />
            </>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub, tone, icon: Icon }) {
  const toneCls = tone === 'green' ? 'text-[#0c9765] dark:text-[#10b981]'
    : tone === 'amber' ? 'text-amber-600 dark:text-amber-400'
    : 'text-neutral-900 dark:text-white';
  return (
    <div className="premium-card">
      <div className="flex items-center gap-1.5">
        {Icon && <Icon size={12} className="text-neutral-400" />}
        <p className="text-2xs font-bold uppercase tracking-wider text-neutral-450">{label}</p>
      </div>
      <p className={`text-xl font-bold tabular-nums mt-1 ${toneCls}`}>{value}</p>
      {sub && <p className="text-2xs text-neutral-500 mt-0.5">{sub}</p>}
    </div>
  );
}
