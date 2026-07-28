// Attendance screen.
//
// Attendance is DERIVED from BioTime face-terminal punches by the engine in services/attendance —
// there is no punch button here any more, because punching happens at the terminal. What this
// screen does is show what the engine concluded, surface the exceptions HR must act on, and let
// people raise a correction when the device missed something.
import React, { useMemo, useState } from 'react';
import {
  Clock, Users, AlertTriangle, CalendarDays, Loader2, Download, RefreshCw,
  CheckCircle2, XCircle, ChevronLeft, ChevronRight, Search, FileSpreadsheet, Info,
} from 'lucide-react';
import {
  useAttendanceSummary, useMonthlyAttendance, useAttendanceExceptions,
  useRawPunches, useRecompute, useExportRegister, useExportPayroll,
  todayIso, STATUS_STYLES, STATUS_CODES, fmtTime, fmtMinutes,
} from '../data/attendance';
import {
  useRegularizations, useMyRegularizations, useCreateRegularization, useDecideRegularization,
} from '../data/regularizations';
import { useAuth } from '../auth/AuthContext';
import { usePermissions } from '../auth/usePermissions';
import { BreakSummary } from './ui/PunchTimeline';
import Pagination, { usePagination } from './ui/Pagination';
import FilterSelect from './ui/FilterSelect';

const TABS = [
  { id: 'today', label: 'Today', icon: Users },
  { id: 'calendar', label: 'Monthly calendar', icon: CalendarDays },
  { id: 'exceptions', label: 'Exceptions', icon: AlertTriangle, perm: 'attendance.manage' },
  { id: 'regularizations', label: 'Regularizations', icon: CheckCircle2 },
];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function StatusBadge({ status, isLop }) {
  return (
    <span className={`badge ${STATUS_STYLES[status] ?? 'badge-muted'}`}>
      {isLop ? 'LOP' : status}
    </span>
  );
}

function Kpi({ icon: Icon, label, value, tone = 'neutral' }) {
  const tones = {
    neutral: 'text-neutral-800 dark:text-neutral-100',
    green: 'text-emerald-600 dark:text-emerald-400',
    amber: 'text-amber-600 dark:text-amber-400',
    red: 'text-red-600 dark:text-red-400',
  };
  return (
    <div className="premium-card">
      <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
        <Icon size={13} />
        {label}
      </div>
      <div className={`mt-2 text-2xl font-black font-mono ${tones[tone]}`}>{value}</div>
    </div>
  );
}

function ErrorNote({ error }) {
  if (!error) return null;
  return (
    <div className="premium-card border-red-300 dark:border-red-900/60">
      <div className="flex items-start gap-2 text-xs text-red-700 dark:text-red-300">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <span>{error.message || String(error)}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Today — who is in
// ---------------------------------------------------------------------------

function TodayView({ workDate, setWorkDate }) {
  const { data = [], isLoading, error, summary, refetch, isFetching } = useAttendanceSummary(workDate);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  // Where, as well as what. A day is 242 rows across 4 companies and 46 branches; a shop manager
  // asking "who is in at Chalakudy today" could not get there from a status filter alone.
  const [company, setCompany] = useState('All companies');
  const [branch, setBranch] = useState('All branches');
  const [dept, setDept] = useState('All departments');
  // The chips above cover the three questions asked every morning. This covers the rest —
  // Half Day, On Leave, Missing Punch, No Shift — which have no chip and were unreachable.
  const [status, setStatus] = useState('All statuses');

  // Options come from the day's own rows, so they never offer a branch with nobody in it.
  const { companyOptions, branchOptions, deptOptions, statusOptions } = useMemo(() => {
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
      statusOptions: ['All statuses', ...ranked],
    };
  }, [data]);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return data.filter((row) => {
      if (filter === 'in' && !(row.check_in && !row.check_out)) return false;
      if (filter === 'absent' && row.status !== 'Absent') return false;
      if (filter === 'late' && !row.is_late) return false;
      if (filter === 'exceptions' && !(row.is_late || row.is_missing_punch || row.is_early_exit)) return false;
      if (company !== 'All companies' && row.employee?.entity?.name !== company) return false;
      if (branch !== 'All branches'
          && (row.employee?.branch?.name || row.employee?.branch?.code) !== branch) return false;
      if (dept !== 'All departments' && row.employee?.department?.name !== dept) return false;
      if (status !== 'All statuses' && row.status !== status) return false;
      if (!term) return true;
      return (
        row.employee?.full_name?.toLowerCase().includes(term) ||
        row.employee?.employee_code?.toLowerCase().includes(term) ||
        row.employee?.branch?.name?.toLowerCase().includes(term)
      );
    });
  }, [data, query, filter, company, branch, dept, status]);

  // 242 people is 242 rows a day, so the table pages. Declared after `filtered` and before any
  // early return, so the hook order is identical on every render.
  const pager = usePagination(filtered);

  const activeFilters =
    (query ? 1 : 0) + (company !== 'All companies' ? 1 : 0) +
    (branch !== 'All branches' ? 1 : 0) + (dept !== 'All departments' ? 1 : 0) +
    (status !== 'All statuses' ? 1 : 0);
  const clearFilters = () => {
    setQuery(''); setCompany('All companies'); setBranch('All branches');
    setDept('All departments'); setStatus('All statuses');
  };

  const filters = [
    { id: 'all', label: `All (${summary.total})` },
    { id: 'in', label: `On site (${summary.stillIn})` },
    { id: 'late', label: `Late (${summary.late})` },
    { id: 'absent', label: `Absent (${summary.absent})` },
    { id: 'exceptions', label: 'Exceptions' },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Kpi icon={Users} label="Roster" value={summary.total} />
        <Kpi icon={CheckCircle2} label="Checked in" value={summary.checkedIn} tone="green" />
        <Kpi icon={Clock} label="Still on site" value={summary.stillIn} tone="green" />
        <Kpi icon={AlertTriangle} label="Late" value={summary.late} tone="amber" />
        <Kpi icon={XCircle} label="Absent" value={summary.absent} tone="red" />
        <Kpi icon={Info} label="Missing punch" value={summary.missingPunch} tone="amber" />
      </div>

      <div className="premium-card space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={workDate}
            onChange={(e) => setWorkDate(e.target.value || todayIso())}
            className="bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 px-3 py-1.5 rounded-xl text-xs"
          />
          <div className="relative flex-1 min-w-45">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
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

        {/* Where — company, branch, department. The status chips below answer "what". */}
        <div className="grid grid-cols-1 sm:flex sm:flex-wrap sm:items-center gap-2 pt-2.5 border-t border-neutral-100 dark:border-neutral-850">
          <FilterSelect label="Company" value={company} options={companyOptions}
            onChange={setCompany} allValue="All companies" />
          <FilterSelect label="Branch" value={branch} options={branchOptions}
            onChange={setBranch} allValue="All branches" />
          <FilterSelect label="Dept" value={dept} options={deptOptions}
            onChange={setDept} allValue="All departments" />
          <FilterSelect label="Status" value={status} options={statusOptions}
            onChange={setStatus} allValue="All statuses" />
          {activeFilters > 0 && (
            <button onClick={clearFilters}
              className="inline-flex items-center justify-center gap-1.5 text-xs font-bold text-neutral-500 hover:text-red-600 dark:hover:text-red-400 cursor-pointer sm:ml-auto py-1.5">
              <XCircle size={12} /> Clear {activeFilters} filter{activeFilters === 1 ? '' : 's'}
            </button>
          )}
        </div>

        <div className="flex flex-wrap gap-1.5">
          {filters.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`chip text-xs mx-2 ${filter === f.id ? 'ring-1 ring-emerald-500 text-emerald-700 dark:text-emerald-300' : ''}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <ErrorNote error={error} />

      <div className="premium-card overflow-hidden">
        {isLoading ? (
          <div className="p-10 flex justify-center text-neutral-400">
            <Loader2 className="animate-spin" size={18} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center text-xs text-neutral-500">
            No attendance rows for {workDate}.
            <div className="mt-1 text-xs text-neutral-400">
              If punches exist but rows do not, the engine has not processed this date yet.
            </div>
          </div>
        ) : (
          <div className="table-scroll">
            <div className="table-scroll -mx-1 px-1"><table className="premium-table w-full text-xs">
              <thead>
                <tr>
                  <th className="text-left">Employee</th>
                  <th className="text-left">Branch</th>
                  <th className="text-left">Shift</th>
                  <th className="text-left">In</th>
                  <th className="text-left">Out</th>
                  <th className="text-left">Worked</th>
                  <th className="text-left hidden lg:table-cell" title="Breaks taken today and total time out">Breaks</th>
                  <th className="text-left">OT</th>
                  <th className="text-left">Status</th>
                </tr>
              </thead>
              <tbody>
                {pager.slice.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <div className="font-semibold text-neutral-800 dark:text-neutral-100">
                        {row.employee?.full_name ?? '—'}
                      </div>
                      <div className="text-2xs text-neutral-400 font-mono">
                        {row.employee?.employee_code ?? ''}
                      </div>
                    </td>
                    <td className="text-neutral-500">{row.employee?.branch?.name ?? '—'}</td>
                    <td className="text-neutral-500">{row.shift?.code ?? '—'}</td>
                    <td className={`font-mono ${row.is_late ? 'text-amber-600 dark:text-amber-400 font-bold' : ''}`}>
                      {fmtTime(row.check_in)}
                      {row.is_late ? <span className="ml-1 text-2xs">+{row.late_minutes}m</span> : null}
                    </td>
                    <td className={`font-mono ${row.is_early_exit ? 'text-amber-600 dark:text-amber-400' : ''}`}>
                      {fmtTime(row.check_out)}
                    </td>
                    <td className="font-mono">{fmtMinutes(row.worked_minutes)}</td>
                    <td className="hidden lg:table-cell font-mono"><BreakSummary row={row} /></td>
                    <td className="font-mono text-emerald-600 dark:text-emerald-400">
                      {fmtMinutes(row.ot_minutes)}
                    </td>
                    <td><StatusBadge status={row.status} isLop={row.is_lop} /></td>
                  </tr>
                ))}
                <Pagination {...pager} noun="rows" />
              </tbody>
            </table></div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Monthly calendar
// ---------------------------------------------------------------------------

function CalendarView({ employeeId, employeeName }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [selected, setSelected] = useState(null);

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
    setYear(next.getUTCFullYear());
    setMonth(next.getUTCMonth() + 1);
    setSelected(null);
  };

  if (!employeeId) {
    return (
      <div className="premium-card p-10 text-center text-xs text-neutral-500">
        No employee record is linked to your login, so there is no calendar to show.
      </div>
    );
  }

  const selectedRow = selected ? byDate.get(selected) : null;

  return (
    <div className="space-y-4">
      <div className="premium-card flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button onClick={() => shiftMonth(-1)} className="p-1.5 rounded-lg bg-neutral-100 dark:bg-neutral-900 hover:bg-neutral-200 dark:hover:bg-neutral-800">
            <ChevronLeft size={14} />
          </button>
          <span className="text-sm font-bold min-w-37.5 text-center">{MONTHS[month - 1]} {year}</span>
          <button onClick={() => shiftMonth(1)} className="p-1.5 rounded-lg bg-neutral-100 dark:bg-neutral-900 hover:bg-neutral-200 dark:hover:bg-neutral-800">
            <ChevronRight size={14} />
          </button>
        </div>
        <div className="flex flex-wrap gap-4 text-xs">
          <span><b className="font-mono text-emerald-600 dark:text-emerald-400">{totals.payable.toFixed(1)}</b> payable days</span>
          <span><b className="font-mono">{fmtMinutes(totals.ot)}</b> OT</span>
          <span><b className="font-mono text-red-600 dark:text-red-400">{totals.absent}</b> absent</span>
          <span><b className="font-mono text-amber-600 dark:text-amber-400">{totals.late}</b> late</span>
          <span><b className="font-mono">{totals.leave}</b> leave</span>
        </div>
      </div>

      <ErrorNote error={error} />

      <div className="premium-card">
        <div className="text-xs text-neutral-500 mb-3">{employeeName}</div>

        {isLoading ? (
          <div className="p-10 flex justify-center text-neutral-400"><Loader2 className="animate-spin" size={18} /></div>
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
                      ${isSelected ? 'ring-2 ring-emerald-500 border-transparent' : 'border-neutral-200 dark:border-neutral-850'}
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
        <div className="premium-card space-y-3 animate-fade-in">
          <h4 className="text-xs font-bold uppercase tracking-wider text-neutral-600 dark:text-neutral-300">
            {selected}
          </h4>

          {selectedRow ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <div>
                <div className="text-2xs text-neutral-400 uppercase">Status</div>
                <StatusBadge status={selectedRow.status} isLop={selectedRow.is_lop} />
              </div>
              <div>
                <div className="text-2xs text-neutral-400 uppercase">In / Out</div>
                <span className="font-mono">{fmtTime(selectedRow.check_in)} – {fmtTime(selectedRow.check_out)}</span>
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
          <div>
            <div className="text-2xs text-neutral-400 uppercase mb-1.5">Raw device punches</div>
            {punches.length === 0 ? (
              <p className="text-xs text-neutral-500">No punches recorded around this date.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {punches.map((p) => (
                  <span
                    key={p.id}
                    className="chip text-2xs font-mono"
                    title={`${p.terminal_alias ?? p.terminal_sn ?? ''} · ${p.source}`} aria-label={`${p.terminal_alias ?? p.terminal_sn ?? ''} · ${p.source}`}
                  >
                    {fmtTime(p.punch_time)}
                    {p.punch_state_label ? ` ${p.punch_state_label}` : ''}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Exceptions + reports
// ---------------------------------------------------------------------------

function ExceptionsView() {
  const today = todayIso();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(weekAgo);
  const [to, setTo] = useState(today);

  const { data = [], isLoading, error, refetch } = useAttendanceExceptions(from, to);
  const recompute = useRecompute();
  const exportRegister = useExportRegister();
  const exportPayroll = useExportPayroll();

  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [year, setYear] = useState(new Date().getFullYear());

  return (
    <div className="space-y-4">
      <div className="premium-card space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-2xs uppercase tracking-wider text-neutral-500">
            From
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              className="block mt-1 bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 px-3 py-1.5 rounded-xl text-xs" />
          </label>
          <label className="text-2xs uppercase tracking-wider text-neutral-500">
            To
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
              className="block mt-1 bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 px-3 py-1.5 rounded-xl text-xs" />
          </label>

          <button
            onClick={() => recompute.mutate({ from, to }, { onSuccess: () => refetch() })}
            disabled={recompute.isPending}
            className="px-3 py-2 rounded-xl bg-neutral-900 dark:bg-[#0ea971] text-white text-xs font-bold flex items-center gap-1.5 disabled:opacity-50"
          >
            {recompute.isPending ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            Recompute range
          </button>
        </div>

        {recompute.isError ? <ErrorNote error={recompute.error} /> : null}
        {recompute.isSuccess ? (
          <p className="text-xs text-emerald-600 dark:text-emerald-400">
            {/* Ranges over 31 days come back as 202 {message} with no counts. */}
            {recompute.data?.message ||
              `Recomputed ${recompute.data?.rowsWritten ?? 0} rows across ${recompute.data?.employees ?? 0} employees.`}
          </p>
        ) : null}

        <div className="soft-divider" />

        <div className="flex flex-wrap items-end gap-3">
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

          <button
            onClick={() => exportRegister.mutate({ year, month })}
            disabled={exportRegister.isPending}
            className="px-3 py-2 rounded-xl bg-neutral-100 dark:bg-neutral-900 hover:bg-neutral-200 dark:hover:bg-neutral-800 text-xs font-bold flex items-center gap-1.5 disabled:opacity-50"
          >
            {exportRegister.isPending ? <Loader2 size={13} className="animate-spin" /> : <FileSpreadsheet size={13} />}
            Attendance register
          </button>

          <button
            onClick={() => exportPayroll.mutate({ year, month })}
            disabled={exportPayroll.isPending}
            className="px-3 py-2 rounded-xl bg-neutral-100 dark:bg-neutral-900 hover:bg-neutral-200 dark:hover:bg-neutral-800 text-xs font-bold flex items-center gap-1.5 disabled:opacity-50"
          >
            {exportPayroll.isPending ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            Payroll export
          </button>
        </div>

        {exportRegister.isError || exportPayroll.isError ? (
          <ErrorNote error={exportRegister.error || exportPayroll.error} />
        ) : null}
      </div>

      <ErrorNote error={error} />

      <div className="premium-card overflow-hidden">
        {isLoading ? (
          <div className="p-10 flex justify-center text-neutral-400"><Loader2 className="animate-spin" size={18} /></div>
        ) : data.length === 0 ? (
          <div className="p-10 text-center text-xs text-neutral-500">No exceptions in this range.</div>
        ) : (
          <div className="table-scroll">
            <div className="table-scroll -mx-1 px-1"><table className="premium-table w-full text-xs">
              <thead>
                <tr>
                  <th className="text-left">Date</th>
                  <th className="text-left">Employee</th>
                  <th className="text-left">Branch</th>
                  <th className="text-left">Issue</th>
                  <th className="text-left">In</th>
                  <th className="text-left">Out</th>
                  <th className="text-left">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.map((row) => {
                  const issues = [
                    row.status === 'Absent' ? 'Absent' : null,
                    row.is_missing_punch ? 'Missing punch' : null,
                    row.is_late ? `Late ${row.late_minutes}m` : null,
                    row.is_early_exit ? `Early ${row.early_exit_minutes}m` : null,
                    row.status === 'No Shift' ? 'No shift assigned' : null,
                  ].filter(Boolean);

                  return (
                    <tr key={row.id}>
                      <td className="font-mono">{row.work_date}</td>
                      <td>
                        <div className="font-semibold text-neutral-800 dark:text-neutral-100">{row.employee?.full_name ?? '—'}</div>
                        <div className="text-2xs text-neutral-400 font-mono">{row.employee?.employee_code ?? ''}</div>
                      </td>
                      <td className="text-neutral-500">{row.employee?.branch?.name ?? '—'}</td>
                      <td>
                        <div className="flex flex-wrap gap-1">
                          {issues.map((issue) => (
                            <span key={issue} className="badge bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">{issue}</span>
                          ))}
                        </div>
                      </td>
                      <td className="font-mono">{fmtTime(row.check_in)}</td>
                      <td className="font-mono">{fmtTime(row.check_out)}</td>
                      <td><StatusBadge status={row.status} isLop={row.is_lop} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Regularizations
// ---------------------------------------------------------------------------

function RegularizationsView({ employee, canApprove }) {
  const { data: queue = [], isLoading } = useRegularizations(canApprove ? 'Pending' : undefined);
  const { data: mine = [] } = useMyRegularizations(employee?.id);
  const create = useCreateRegularization();
  const decide = useDecideRegularization();

  const [form, setForm] = useState({ workDate: todayIso(), checkIn: '', checkOut: '', reason: '' });

  const submit = (e) => {
    e.preventDefault();
    if (!employee?.id) return;
    if (!form.checkIn && !form.checkOut) return;
    create.mutate(
      { employeeId: employee.id, ...form },
      { onSuccess: () => setForm({ workDate: todayIso(), checkIn: '', checkOut: '', reason: '' }) }
    );
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-1 space-y-4">
        <form onSubmit={submit} className="premium-card space-y-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-700 dark:text-neutral-200">
            Raise a correction
          </h3>
          <p className="text-xs text-neutral-500">
            For a day the terminal missed a punch. Approval feeds back into the engine, which
            recomputes that date.
          </p>

          <label className="block text-2xs uppercase tracking-wider text-neutral-500">
            Date
            <input type="date" required value={form.workDate}
              onChange={(e) => setForm({ ...form, workDate: e.target.value })}
              className="block w-full mt-1 bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 px-3 py-1.5 rounded-xl text-xs" />
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="block text-2xs uppercase tracking-wider text-neutral-500">
              Check in
              <input type="time" value={form.checkIn}
                onChange={(e) => setForm({ ...form, checkIn: e.target.value })}
                className="block w-full mt-1 bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 px-2 py-1.5 rounded-xl text-xs" />
            </label>
            <label className="block text-2xs uppercase tracking-wider text-neutral-500">
              Check out
              <input type="time" value={form.checkOut}
                onChange={(e) => setForm({ ...form, checkOut: e.target.value })}
                className="block w-full mt-1 bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 px-2 py-1.5 rounded-xl text-xs" />
            </label>
          </div>

          <label className="block text-2xs uppercase tracking-wider text-neutral-500">
            Reason
            <textarea required rows={2} value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              placeholder="Face reader did not register on exit"
              className="block w-full mt-1 bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 px-3 py-1.5 rounded-xl text-xs" />
          </label>

          <button type="submit" disabled={create.isPending || !employee?.id}
            className="w-full py-2 rounded-xl bg-neutral-900 dark:bg-[#0ea971] text-white text-xs font-bold disabled:opacity-50">
            {create.isPending ? 'Submitting…' : 'Submit for approval'}
          </button>

          {create.isError ? <ErrorNote error={create.error} /> : null}
          {create.isSuccess ? <p className="text-xs text-emerald-600 dark:text-emerald-400">Submitted.</p> : null}
          {!employee?.id ? <p className="text-xs text-amber-600">Your login is not linked to an employee record.</p> : null}
        </form>

        <div className="premium-card">
          <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-700 dark:text-neutral-200 mb-2">
            My requests
          </h3>
          {mine.length === 0 ? (
            <p className="text-xs text-neutral-500">Nothing raised yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {mine.slice(0, 8).map((r) => (
                <li key={r.id} className="flex items-center justify-between text-xs">
                  <span className="font-mono">{r.work_date}</span>
                  <span className={`badge ${r.status === 'Approved' ? 'badge-green' : r.status === 'Rejected' ? 'bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300' : 'badge-muted'}`}>
                    {r.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="lg:col-span-2">
        <div className="premium-card overflow-hidden">
          <div className="p-4 pb-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-700 dark:text-neutral-200">
              {canApprove ? 'Pending approval' : 'Recent requests'}
            </h3>
          </div>

          {isLoading ? (
            <div className="p-10 flex justify-center text-neutral-400"><Loader2 className="animate-spin" size={18} /></div>
          ) : queue.length === 0 ? (
            <div className="p-10 text-center text-xs text-neutral-500">Nothing waiting.</div>
          ) : (
            <div className="table-scroll">
              <div className="table-scroll -mx-1 px-1"><table className="premium-table w-full text-xs">
                <thead>
                  <tr>
                    <th className="text-left">Date</th>
                    <th className="text-left">Employee</th>
                    <th className="text-left">Proposed</th>
                    <th className="text-left">Reason</th>
                    {canApprove ? <th className="text-right">Decision</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {queue.map((r) => (
                    <tr key={r.id}>
                      <td className="font-mono">{r.work_date}</td>
                      <td>
                        <div className="font-semibold text-neutral-800 dark:text-neutral-100">{r.employee?.full_name ?? '—'}</div>
                        <div className="text-2xs text-neutral-400">{r.employee?.branch?.name ?? ''}</div>
                      </td>
                      <td className="font-mono">{fmtTime(r.check_in)} – {fmtTime(r.check_out)}</td>
                      <td className="max-w-55 truncate text-neutral-500" title={r.reason} aria-label={r.reason}>{r.reason}</td>
                      {canApprove ? (
                        <td className="text-right whitespace-nowrap">
                          <button
                            onClick={() => decide.mutate({ id: r.id, decision: 'Approved' })}
                            disabled={decide.isPending}
                            className="px-2 py-1 rounded-lg bg-[#0ea971] text-white text-2xs font-bold mr-1 disabled:opacity-50"
                          >
                            Approve
                          </button>
                          <button
                            onClick={() => decide.mutate({ id: r.id, decision: 'Rejected' })}
                            disabled={decide.isPending}
                            className="px-2 py-1 rounded-lg bg-neutral-200 dark:bg-neutral-800 text-2xs font-bold disabled:opacity-50"
                          >
                            Reject
                          </button>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function Attendance() {
  const { employee } = useAuth();
  const { canAny } = usePermissions();
  const [tab, setTab] = useState('today');
  const [workDate, setWorkDate] = useState(todayIso());

  const visibleTabs = TABS.filter((t) => !t.perm || canAny(t.perm));
  const canApprove = canAny('regularization.approve');

  return (
    <div className="page-shell space-y-5 animate-slide-up py-3">
      <div>
        <h1 className="text-xl font-bold text-neutral-900 dark:text-white leading-tight font-sans flex items-center gap-2">Attendance</h1>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
          Sourced from the ZKTeco face terminals via BioTime. Punches sync every couple of minutes
          and the engine derives each day against the assigned shift.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {visibleTabs.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`drawer-tab flex items-center gap-1.5 ${tab === t.id ? 'drawer-tab-active' : ''}`}
            >
              <Icon size={13} />
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'today' ? <TodayView workDate={workDate} setWorkDate={setWorkDate} /> : null}
      {tab === 'calendar' ? <CalendarView employeeId={employee?.id} employeeName={employee?.full_name} /> : null}
      {tab === 'exceptions' ? <ExceptionsView /> : null}
      {tab === 'regularizations' ? <RegularizationsView employee={employee} canApprove={canApprove} /> : null}
    </div>
  );
}
