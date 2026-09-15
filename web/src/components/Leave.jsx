import { SkeletonCards, SkeletonRows } from './ui/Skeleton';
import React, { useState, useMemo, useEffect } from 'react';
import { Calendar, FileText, CheckCircle2, Clock, Plus } from 'lucide-react';
import { useHolidays } from '../data/holidays';
import { useLeaveBalances, useLeaveTypes } from '../data/leaveTypes';
import { useLeaves, useApplyLeave } from '../data/leaves';
import { useAuth } from '../auth/AuthContext';
import { useMineOnly } from '../lib/useMineOnly';
import { usePermissions } from '../auth/usePermissions';
import { btnClass } from './ui/Btn';
import Pagination, { usePagination } from './ui/Pagination';
import { useFocusRow } from '../lib/useFocusRow';
import { canReviewLeave, leaveDecisionsFor, leaveStageLabel, matchesLeaveFilter } from '../lib/leaveWorkflow';
import LeaveReviewPanel from './LeaveReviewPanel';
import FormSection from './ui/FormSection';
import QueryError from './ui/QueryError';

/**
 * The catalog decides what a leave is called — this file no longer does.
 *
 * There was a hardcoded label list here ('Casual Leave', 'Comp Off', …) and the form wrote those
 * labels into leaves.type. But the engine joins leave_types.code = leaves.type ('CL', 'CO', …) —
 * migration 0014 says so in its header — so no request filed from this screen ever matched a leave
 * type: balances were never deducted, and an explicitly unpaid Loss of Pay leave was paid in full
 * because the no-match fallback treats an unknown type as plain paid leave. The form now offers
 * the same leave_types table the engine reads, and writes the CODE.
 */
const FALLBACK_TYPE_NAMES = {
  CL: 'Casual Leave', SL: 'Sick Leave', EL: 'Earned Leave',
  CO: 'Comp Off', MAT: 'Maternity Leave', LOP: 'Loss of Pay (LOP)',
};
const LEAVE_FILTERS = ['All', 'My review queue', 'Department review', 'HR sanction', 'Pending', 'On Hold', 'Approved', 'Rejected', 'Cancelled'];

const statusClass = (s) =>
  s === 'Approved'
    ? 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900/30'
    : s === 'Rejected'
    ? 'bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-900/30'
    : s === 'On Hold'
    ? 'bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-900/30'
    : s === 'Cancelled'
    ? 'bg-neutral-100 text-neutral-400 border-neutral-200 dark:bg-neutral-900 dark:text-neutral-500 dark:border-neutral-800'
    : 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900/30';

function daysBetween(a, b) {
  const d1 = new Date(a), d2 = new Date(b);
  if (isNaN(d1) || isNaN(d2)) return 0;
  if (d2 < d1) return 0;
  return Math.ceil((d2 - d1) / 86400000) + 1;
}

function MyLeaveHero({ balances, stats, canApply, onApply, onFilter }) {
  const available = balances.reduce((n, b) => n + Number(b.available || 0), 0);
  const nextBalance = balances
    .slice()
    .sort((a, b) => Number(b.available || 0) - Number(a.available || 0))[0];

  return (
    <section className="premium-card self-service-hero">
      <div className="self-service-hero-copy">
        <span className="self-service-eyebrow">My leave</span>
        <h2>{available > 0 ? `${available} day${available === 1 ? '' : 's'} available` : 'Leave balance'}</h2>
        <p>
          {nextBalance
            ? `${nextBalance.leave_type?.name || nextBalance.leave_type?.code} has ${Number(nextBalance.available || 0)} day${Number(nextBalance.available || 0) === 1 ? '' : 's'} left.`
            : 'Apply for time off and track every request from here.'}
        </p>
      </div>
      <div className="self-service-hero-stats">
        <button type="button" onClick={() => onFilter('All')}>
          <span>Requests</span>
          <strong>{stats.total}</strong>
        </button>
        <button type="button" onClick={() => onFilter('Pending')}>
          <span>Pending</span>
          <strong>{stats.pending}</strong>
        </button>
        <button type="button" onClick={() => onFilter('Approved')}>
          <span>Approved</span>
          <strong>{stats.approved}</strong>
        </button>
        <button type="button" onClick={() => onFilter('Rejected')}>
          <span>Rejected</span>
          <strong>{stats.rejected}</strong>
        </button>
      </div>
      <div className="self-service-hero-actions">
        {canApply ? (
          <button type="button" data-primary="true" onClick={onApply}>
            <Plus size={14} /> Apply leave
          </button>
        ) : null}
        <button type="button" onClick={() => onFilter('Pending')}>
          <Clock size={14} /> Pending
        </button>
        <button type="button" onClick={() => onFilter('Approved')}>
          <CheckCircle2 size={14} /> Approved
        </button>
      </div>
    </section>
  );
}

export default function Leave() {
  // Real company holidays (Attendance Setup -> Holidays), not a hardcoded list.
  const currentYear = new Date().getFullYear();
  const holidayQuery = useHolidays(null, currentYear);
  const { data: holidays = [] } = holidayQuery;
  const holidayPager = usePagination(holidays, 10, null, currentYear);
  const leaveQuery = useLeaves();
  const { data: leaves = [], isLoading, error } = leaveQuery;
  const hasLeaves = Array.isArray(leaveQuery.data);
  const { employee } = useAuth();
  const { canBeyondSelf, viewingAsEmployee } = usePermissions();
  const apply = useApplyLeave();
  const canReview = (request) => canReviewLeave(request, employee?.id, viewingAsEmployee);
  const canApply = Boolean(employee?.id); // only employee-linked logins can request leave

  const typesQuery = useLeaveTypes();
  const { data: leaveTypes = [] } = typesQuery;
  const balanceQuery = useLeaveBalances(employee?.id, currentYear);
  const { data: balances = [] } = balanceQuery;
  // Codes for the form, names for the eye. The name lookup also covers rows written before this
  // fix, which hold display labels: an unknown key falls through to the raw stored value.
  const activeTypes = leaveTypes.filter((t) => t.is_active !== false);
  const typeName = (code) => leaveTypes.find((t) => t.code === code)?.name
    ?? FALLBACK_TYPE_NAMES[code] ?? code;

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ type: 'CL', start: '', end: '', reason: '' });
  const [formError, setFormError] = useState(null);
  const selectedType = activeTypes.find((type) => type.code === form.type);
  const typesReady = !typesQuery.isLoading && !typesQuery.error && Boolean(selectedType);
  const [statusFilter, setStatusFilter] = useState('All');
  const [selectedId, setSelectedId] = useState(null);
  // Self-only unless this viewer's grants reach other people. Covers a genuine employee AND a
  // manager who switched to the employee view — usePermissions narrows the grants, this follows.
  const [mineOnly, setMineOnly, canPickWhose] = useMineOnly(canBeyondSelf('leave.read'));

  const scopedLeaves = useMemo(() => mineOnly ? leaves.filter((l) => l.employee_id === employee?.id) : leaves,
    [leaves, mineOnly, employee?.id]);
  const visibleLeaves = useMemo(() => scopedLeaves.filter((l) => matchesLeaveFilter(l, statusFilter, employee?.id, viewingAsEmployee)),
    [scopedLeaves, statusFilter, employee?.id, viewingAsEmployee]);

  const stats = useMemo(() => {
    // Counted over the SAME rows the list shows, or 'Mine' displays your two requests above a
    // tile reading 40.
    const by = (s) => scopedLeaves.filter((l) => l.status === s).length;
    return {
      total: scopedLeaves.length,
      pending: by('Pending'),
      onHold: by('On Hold'),
      approved: by('Approved'),
      rejected: by('Rejected'),
    };
  }, [scopedLeaves]);
  const selfServiceMode = canApply && (mineOnly || viewingAsEmployee);

  const submit = async (e) => {
    e.preventDefault();
    if (apply.isPending || !typesReady) return;
    setFormError(null);
    apply.reset();
    if (!form.start || !form.end || !form.reason.trim() || !employee?.id) return;
    if (form.end < form.start) {
      setFormError('End date cannot be before start date.');
      return;
    }
    try {
      await apply.mutateAsync({
        employee_id: employee.id,
        type: form.type,
        start_date: form.start,
        end_date: form.end,
        days: daysBetween(form.start, form.end),
        reason: form.reason.trim(),
      });
      setForm({ type: 'CL', start: '', end: '', reason: '' });
      setFormError(null);
      setShowForm(false);
    } catch { /* error shown below */ }
  };


  // Paged: this list grows with the business and was rendering every row.
  // A notification can point at one request; land on its page and mark it. See focusRow.js.
  const { focusId, rowProps } = useFocusRow();
  useEffect(() => {
    const request = leaves.find((row) => row.id === focusId);
    if (!request) return;
    setSelectedId(request.id);
    setStatusFilter('All');
    if (request.employee_id !== employee?.id && canPickWhose) setMineOnly(false);
  }, [focusId, leaves, employee?.id, canPickWhose, setMineOnly]);
  const pager = usePagination(visibleLeaves, 25, focusId, `${statusFilter}:${mineOnly}`);
  const selected = scopedLeaves.find((row) => row.id === selectedId);

  return (
    <div className="page-shell space-y-6 animate-slide-up">
      <div className="mobile-list-row flex justify-between items-center">
        <div>
          <h1 className="text-xl font-bold text-neutral-900 dark:text-white leading-tight font-sans flex items-center gap-2">
            {selfServiceMode ? 'My Leave' : 'Leave Management'}
          </h1>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
            {selfServiceMode
              ? 'Apply for time off and follow every request.'
              : 'Department head review followed by HR sanction, with a record of every decision.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Their whole branch by default. A manager also takes leave, and 0080 gave them
              leave.create to request it — this is how they find their own requests in the list. */}
          {canPickWhose && canApply && (
            <div className="inline-flex rounded-xl border border-neutral-200 dark:border-neutral-800 p-0.5" role="group" aria-label="Whose requests">
              {[['Mine', true], ['Everyone', false]].map(([label, v]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setMineOnly(v)}
                  aria-pressed={mineOnly === v}
                  className={`px-2.5 py-1 text-2xs font-bold rounded-lg transition-colors cursor-pointer ${
                    mineOnly === v
                      ? 'bg-brand-action text-brand-on'
                      : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        {canApply && !showForm && (
          <button
            onClick={() => setShowForm(true)}
            className={btnClass('primary')}
          >
            <span>Apply Leave</span>
          </button>
        )}
        </div>
      </div>

      {selected && <LeaveReviewPanel key={selected.id} request={selected} onClose={() => setSelectedId(null)} />}

      <QueryError error={error} title={hasLeaves ? 'Leave requests could not be refreshed.' : 'Leave requests could not be loaded.'}
        onRetry={leaveQuery.refetch} retrying={leaveQuery.isFetching} hasData={hasLeaves} />
      {!showForm && <QueryError error={typesQuery.error} title="Leave types could not be loaded."
        onRetry={typesQuery.refetch} retrying={typesQuery.isFetching} hasData={Array.isArray(typesQuery.data)} />}
      {selfServiceMode && <QueryError error={balanceQuery.error} title="Leave balances could not be loaded."
        onRetry={balanceQuery.refetch} retrying={balanceQuery.isFetching} hasData={Array.isArray(balanceQuery.data)} />}

      {selfServiceMode && balanceQuery.isLoading ? <SkeletonCards count={1} label="Loading leave balance" /> : null}
      {selfServiceMode && Array.isArray(balanceQuery.data) && hasLeaves ? (
        <MyLeaveHero
          balances={balances}
          stats={stats}
          canApply={canApply}
          onApply={() => setShowForm(true)}
          onFilter={setStatusFilter}
        />
      ) : null}

      {/* stats from real data */}
      {isLoading ? <SkeletonCards count={5} label="Loading leave totals" /> : hasLeaves && <div className={`grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 ${selfServiceMode ? 'employee-secondary-stats' : ''}`}>
        <Stat label="Total Requests" value={stats.total} active={statusFilter === 'All'} onClick={() => setStatusFilter('All')} />
        <Stat label="Pending" value={stats.pending} active={statusFilter === 'Pending'} onClick={() => setStatusFilter('Pending')} />
        <Stat label="On Hold" value={stats.onHold} active={statusFilter === 'On Hold'} onClick={() => setStatusFilter('On Hold')} />
        <Stat label="Approved" value={stats.approved} active={statusFilter === 'Approved'} onClick={() => setStatusFilter('Approved')} />
        <Stat label="Rejected" value={stats.rejected} active={statusFilter === 'Rejected'} onClick={() => setStatusFilter('Rejected')} />
      </div>}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* list */}
        <div className={`${showForm ? 'lg:col-span-2' : 'lg:col-span-3'} space-y-4`}>
          <div className="premium-card space-y-4">
            <h3 className="font-bold text-xs uppercase tracking-wider text-neutral-800 dark:text-neutral-100 border-b border-neutral-100 dark:border-neutral-900 pb-2.5 flex items-center">
              <FileText size={16} className="mr-2 text-neutral-600 dark:text-neutral-400" />
              {selfServiceMode ? 'My Requests' : 'Leave Requests'}
            </h3>
            <label className="flex flex-wrap items-center gap-2 text-xs font-semibold">
              Show requests
              <select aria-label="Filter leave requests" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}
                className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-3 py-2 max-w-full">
                {LEAVE_FILTERS.filter((filter) => filter !== 'My review queue' || canPickWhose).map((filter) => <option key={filter}>{filter}</option>)}
              </select>
            </label>

            {isLoading ? (
              <SkeletonRows rows={4} avatar={false} label="Loading leave requests" />
            ) : visibleLeaves.length === 0 ? error ? null : (
              <p className="text-xs text-neutral-500 py-8 text-center">
                No {statusFilter === 'All' ? '' : `${statusFilter.toLowerCase()} `}leave requests yet.
              </p>
            ) : (
              <div className="space-y-3.5">
                {pager.slice.map((req) => (
                  <div key={req.id} {...rowProps(req.id)} className="mobile-list-row p-4 bg-neutral-50 dark:bg-neutral-950/20 border border-neutral-200 dark:border-neutral-900 rounded-xl flex items-center justify-between gap-3 text-xs hover:border-neutral-300 dark:hover:border-neutral-800">
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center space-x-2">
                        <span className="font-bold text-neutral-855 dark:text-slate-200">{typeName(req.type)}</span>
                        <span className="text-2xs font-mono px-1.5 py-0.5 bg-neutral-200 dark:bg-neutral-900 text-neutral-500 rounded border border-neutral-305 dark:border-neutral-800">{req.days} day{Number(req.days) === 1 ? '' : 's'}</span>
                      </div>
                      <span className="text-2xs text-neutral-500 block truncate">
                        {req.start_date} → {req.end_date} · {req.employee?.full_name || 'Unknown'}
                        {req.employee?.branch?.code ? ` (${req.employee.branch.code})` : ''}
                      </span>
                      {req.reason && <p className="text-2xs text-neutral-450 italic whitespace-pre-wrap break-words">{req.reason}</p>}
                      {(req.status === 'Pending' || req.status === 'On Hold') && <p className="text-xs font-semibold text-neutral-600 dark:text-neutral-300">{leaveStageLabel(req)}</p>}
                      {req.auto_cancellation_note && (
                        <p className="text-2xs text-amber-700 dark:text-amber-300">
                          {req.auto_cancellation_note}
                          {req.status === 'Approved' && req.cancelled_dates?.length
                            ? ` · ${req.cancelled_dates.length} date${req.cancelled_dates.length === 1 ? '' : 's'} removed`
                            : ''}
                        </p>
                      )}
                    </div>

                    <div className="mobile-list-actions flex items-center gap-2 shrink-0">
                      <span className={`text-2xs px-2 py-0.5 rounded-full font-mono font-bold uppercase tracking-wider border ${statusClass(req.status)}`}>
                        {req.status}
                      </span>
                      <button type="button" onClick={() => setSelectedId(req.id)} className={btnClass('secondary')}
                        aria-label={`${canReview(req) || leaveDecisionsFor(req, employee?.id, viewingAsEmployee).length ? 'Review' : 'View'} leave for ${req.employee?.full_name || typeName(req.type)}`}>
                        {canReview(req) || leaveDecisionsFor(req, employee?.id, viewingAsEmployee).length ? 'Review' : 'Details & remarks'}
                      </button>
                    </div>
                  </div>
                ))}
                <Pagination {...pager} noun="requests" />
              </div>
            )}

          </div>
        </div>

        {/* right column: form or holidays */}
        <div className="order-first lg:order-none lg:col-span-1">
          {showForm && canApply ? (
            <FormSection title="Apply for Leave" onSubmit={submit} submitLabel="Submit leave" busyLabel="Submitting leave…"
              busy={apply.isPending} disabled={!typesReady || !form.start || !form.end || !form.reason.trim()}
              error={formError || apply.error} onClose={() => { apply.reset(); setFormError(null); setShowForm(false); }}>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">Your department head reviews first, then HR sanctions the leave. Requests without an eligible department head go directly to HR.</p>
                <QueryError error={typesQuery.error} title="Leave types could not be loaded."
                  onRetry={typesQuery.refetch} retrying={typesQuery.isFetching} />
                {typesQuery.isLoading && <p role="status" className="text-sm text-neutral-500">Loading leave types…</p>}
                {!typesQuery.isLoading && !typesQuery.error && activeTypes.length === 0 && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">No active leave types are available. Ask HR to configure a leave type before applying.</p>}
                <div className="space-y-1">
                  <label htmlFor="leave-apply-type" className="text-neutral-500 font-semibold uppercase text-2xs tracking-wider">Leave Type</label>
                  <select id="leave-apply-type" required disabled={typesQuery.isLoading || Boolean(typesQuery.error)} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}
                    className="w-full bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 rounded-xl px-3.5 py-2 focus:outline-none focus:border-black dark:focus:border-brand cursor-pointer font-medium">
                    <option value="">Choose a leave type</option>
                    {form.type && !selectedType && <option value={form.type} disabled>Choose an available leave type</option>}
                    {activeTypes.map((t) => (
                      <option key={t.code} value={t.code}>
                        {t.name}{t.is_paid === false ? ' — unpaid' : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label htmlFor="leave-apply-start" className="text-neutral-500 font-semibold uppercase text-2xs tracking-wider">Start</label>
                    <input id="leave-apply-start" type="date" required value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })}
                      className="w-full bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-855 rounded-xl px-3 py-1.5 focus:outline-none focus:border-black dark:focus:border-brand" />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="leave-apply-end" className="text-neutral-500 font-semibold uppercase text-2xs tracking-wider">End</label>
                    <input id="leave-apply-end" type="date" required min={form.start || undefined} value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })}
                      className="w-full bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-855 rounded-xl px-3 py-1.5 focus:outline-none focus:border-black dark:focus:border-brand" />
                  </div>
                </div>
                <div className="space-y-1">
                  <label htmlFor="leave-apply-reason" className="text-neutral-500 font-semibold uppercase text-2xs tracking-wider">Reason</label>
                  <textarea id="leave-apply-reason" required rows={3} placeholder="Reason for time-off…" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}
                    className="w-full bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 rounded-xl px-3.5 py-2 focus:outline-none focus:border-black dark:focus:border-brand resize-none" />
                </div>
            </FormSection>
          ) : (
            <div className="premium-card paged-collection space-y-4 animate-fade-in">
              <h3 className="font-bold text-xs uppercase tracking-wider text-neutral-800 dark:text-neutral-100 border-b border-neutral-100 dark:border-neutral-900 pb-2.5 flex items-center">
                <Calendar size={16} className="mr-2 text-neutral-600 dark:text-neutral-400" /> Holiday Calendar
              </h3>
              <QueryError error={holidayQuery.error} title="Holidays could not be loaded." onRetry={holidayQuery.refetch}
                retrying={holidayQuery.isFetching} hasData={Array.isArray(holidayQuery.data)} />
              {holidayQuery.isLoading && <SkeletonRows rows={3} compact avatar={false} label="Loading holidays" />}
              <div className="space-y-2.5 max-h-[300px] overflow-y-auto pr-1">
                {holidayPager.slice.map((h) => {
                  const [y, mo, d] = h.holiday_date.slice(0, 10).split('-').map(Number);
                  const dt = new Date(Date.UTC(y, mo - 1, d));
                  return (
                    <div key={h.id} className="p-3 bg-neutral-50 dark:bg-neutral-950/20 border border-neutral-200 dark:border-neutral-850 rounded-xl flex justify-between items-center text-xs">
                      <div>
                        <span className="font-semibold text-neutral-700 dark:text-slate-300 block">
                          {h.name}{h.is_optional ? ' (optional)' : ''}
                        </span>
                        <span className="text-2xs text-neutral-450">
                          {dt.toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'UTC' })}
                        </span>
                      </div>
                      <span className="font-mono text-neutral-900 dark:text-neutral-100 font-bold">
                        {h.holiday_date.slice(0, 10)}
                      </span>
                    </div>
                  );
                })}
                {!holidayQuery.isLoading && !holidayQuery.error && holidays.length === 0 && (
                  <p className="py-6 text-center text-xs text-neutral-500">
                    No holidays set for {currentYear} yet — add them in Attendance Setup.
                  </p>
                )}
              </div>
              {!holidayQuery.isLoading && <Pagination {...holidayPager} noun="holidays" sizes={[10, 25, 50]} />}
              {!canApply && (
                <p className="text-xs text-neutral-400 border-t border-neutral-100 dark:border-neutral-900 pt-2.5">
                  Your login isn't linked to an employee record, so you can't submit leave for yourself. Link it in Administration → Users &amp; Access.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, onClick, active = false }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      {...(onClick ? { type: 'button', onClick, title: `Show ${label}` } : {})}
      className={`premium-card text-left ${onClick ? 'summary-card-link' : ''} ${active ? 'summary-card-link-active' : ''}`}
    >
      <span className="text-neutral-500 dark:text-neutral-455 text-xs font-bold uppercase tracking-wider block">{label}</span>
      <span className="text-2xl font-extrabold font-mono text-neutral-850 dark:text-slate-100 block mt-1.5">{value}</span>
    </Tag>
  );
}
