import React, { useState, useMemo } from 'react';
import { Calendar, FileText, X, Loader2, AlertTriangle } from 'lucide-react';
import { useHolidays } from '../data/holidays';
import { useLeaves, useApplyLeave, useSetLeaveStatus } from '../data/leaves';
import { useAuth } from '../auth/AuthContext';
import { useMineOnly } from '../lib/useMineOnly';
import { usePermissions } from '../auth/usePermissions';
import { btnClass } from './ui/Btn';
import Pagination, { usePagination } from './ui/Pagination';

const LEAVE_TYPES = ['Casual Leave', 'Sick Leave', 'Earned Leave', 'Maternity Leave', 'Paternity Leave', 'Comp Off', 'Loss of Pay (LOP)'];
const LEAVE_REVIEW_STATUSES = ['Pending', 'On Hold', 'Approved', 'Rejected'];

const statusClass = (s) =>
  s === 'Approved'
    ? 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-450 dark:border-emerald-900/30'
    : s === 'Rejected'
    ? 'bg-rose-100 text-rose-805 border-rose-200 dark:bg-rose-950/40 dark:text-rose-450 dark:border-rose-900/30'
    : s === 'On Hold'
    ? 'bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-900/30'
    : s === 'Cancelled'
    ? 'bg-neutral-100 text-neutral-400 border-neutral-200 dark:bg-neutral-900 dark:text-neutral-500 dark:border-neutral-800'
    : 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-450 dark:border-amber-900/30';

function daysBetween(a, b) {
  const d1 = new Date(a), d2 = new Date(b);
  if (isNaN(d1) || isNaN(d2)) return 0;
  return Math.ceil(Math.abs(d2 - d1) / 86400000) + 1;
}

export default function Leave() {
  // Real company holidays (Attendance Setup -> Holidays), not a hardcoded list.
  const currentYear = new Date().getFullYear();
  const { data: holidays = [] } = useHolidays(null, currentYear);
  const { data: leaves = [], isLoading, error } = useLeaves();
  const { employee } = useAuth();
  const { can, canAny, canBeyondSelf } = usePermissions();
  const apply = useApplyLeave();
  const setStatus = useSetLeaveStatus();

  const canApprove = canAny('leave.approve');
  // Your own request is not yours to decide: app.tg_no_self_leave_decision (0083) raises 42501 on it.
  // Expense.jsx already excludes this case; Leave drew a fully working dropdown that always threw.
  const canReview = (request) => request.employee_id !== employee?.id && can('leave.approve', {
    entityId: request.entity_id,
    zoneId: request.zone_id,
    branchId: request.branch_id,
    deptId: request.department_id,
    employeeId: request.employee_id,
  });
  const canApply = Boolean(employee?.id); // only employee-linked logins can request leave

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ type: 'Casual Leave', start: '', end: '', reason: '' });
  const [statusFilter, setStatusFilter] = useState('All');
  // Self-only unless this viewer's grants reach other people. Covers a genuine employee AND a
  // manager who switched to the employee view — usePermissions narrows the grants, this follows.
  const [mineOnly, setMineOnly, canPickWhose] = useMineOnly(canBeyondSelf('leave.read'));

  const visibleLeaves = useMemo(() => {
    const scoped = mineOnly ? leaves.filter((l) => l.employee_id === employee?.id) : leaves;
    return statusFilter === 'All' ? scoped : scoped.filter((l) => l.status === statusFilter);
  }, [leaves, statusFilter, mineOnly, employee?.id]);

  const stats = useMemo(() => {
    // Counted over the SAME rows the list shows, or 'Mine' displays your two requests above a
    // tile reading 40.
    const by = (s) => visibleLeaves.filter((l) => l.status === s).length;
    return {
      total: visibleLeaves.length,
      pending: by('Pending'),
      onHold: by('On Hold'),
      approved: by('Approved'),
      rejected: by('Rejected'),
    };
  }, [visibleLeaves]);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.start || !form.end || !form.reason || !employee?.id) return;
    try {
      await apply.mutateAsync({
        employee_id: employee.id,
        type: form.type,
        start_date: form.start,
        end_date: form.end,
        days: daysBetween(form.start, form.end),
        reason: form.reason,
      });
      setForm({ type: 'Casual Leave', start: '', end: '', reason: '' });
      setShowForm(false);
    } catch { /* error shown below */ }
  };


  // Paged: this list grows with the business and was rendering every row.
  const pager = usePagination(visibleLeaves);

  return (
    <div className="page-shell space-y-6 animate-slide-up">
      <div className="mobile-list-row flex justify-between items-center">
        <div>
          <h1 className="text-xl font-bold text-neutral-900 dark:text-white leading-tight font-sans flex items-center gap-2">Leave Management</h1>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
            {canApprove ? 'Review and approve requests within your scope.' : 'Submit time-off requests and track their status.'}
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
                      ? 'bg-[#0ea971] text-white'
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

      {/* stats from real data */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <Stat label="Total Requests" value={stats.total} active={statusFilter === 'All'} onClick={() => setStatusFilter('All')} />
        <Stat label="Pending" value={stats.pending} active={statusFilter === 'Pending'} onClick={() => setStatusFilter('Pending')} />
        <Stat label="On Hold" value={stats.onHold} active={statusFilter === 'On Hold'} onClick={() => setStatusFilter('On Hold')} />
        <Stat label="Approved" value={stats.approved} active={statusFilter === 'Approved'} onClick={() => setStatusFilter('Approved')} />
        <Stat label="Rejected" value={stats.rejected} active={statusFilter === 'Rejected'} onClick={() => setStatusFilter('Rejected')} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* list */}
        <div className={`${showForm ? 'lg:col-span-2' : 'lg:col-span-3'} space-y-4`}>
          <div className="premium-card space-y-4">
            <h3 className="font-bold text-xs uppercase tracking-wider text-neutral-800 dark:text-neutral-100 border-b border-neutral-100 dark:border-neutral-900 pb-2.5 flex items-center">
              <FileText size={16} className="mr-2 text-neutral-600 dark:text-neutral-400" /> Leave Requests
            </h3>

            {isLoading ? (
              <div className="flex justify-center py-10 text-[#0ea971]"><Loader2 size={22} className="animate-spin" /></div>
            ) : error ? (
              <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300 py-3">
                <AlertTriangle size={15} className="shrink-0 mt-0.5" /> <span>{error.message}</span>
              </div>
            ) : visibleLeaves.length === 0 ? (
              <p className="text-xs text-neutral-500 py-8 text-center">
                No {statusFilter === 'All' ? '' : `${statusFilter.toLowerCase()} `}leave requests visible to you yet.
              </p>
            ) : (
              <div className="space-y-3.5 max-h-[420px] overflow-y-auto pr-1">
                {pager.slice.map((req) => (
                  <div key={req.id} className="mobile-list-row p-4 bg-neutral-50 dark:bg-neutral-950/20 border border-neutral-200 dark:border-neutral-900 rounded-xl flex items-center justify-between gap-3 text-xs hover:border-neutral-300 dark:hover:border-neutral-800">
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center space-x-2">
                        <span className="font-bold text-neutral-855 dark:text-slate-200">{req.type}</span>
                        <span className="text-2xs font-mono px-1.5 py-0.5 bg-neutral-200 dark:bg-neutral-900 text-neutral-500 rounded border border-neutral-305 dark:border-neutral-800">{req.days} days</span>
                      </div>
                      <span className="text-2xs text-neutral-500 block truncate">
                        {req.start_date} → {req.end_date} · {req.employee?.full_name || 'Unknown'}
                        {req.employee?.branch?.code ? ` (${req.employee.branch.code})` : ''}
                      </span>
                      {req.reason && <p className="text-2xs text-neutral-450 italic font-mono truncate">"{req.reason}"</p>}
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
                      {canReview(req) && req.status !== 'Cancelled' && (
                        <select
                          value={req.status}
                          onChange={(event) => {
                            if (event.target.value !== req.status) {
                              setStatus.mutate({ id: req.id, status: event.target.value });
                            }
                          }}
                          disabled={setStatus.isPending}
                          aria-label={`Change status for ${req.employee?.full_name || req.type}`}
                          title="Change leave status"
                          className="min-w-24 rounded-lg border border-neutral-200 bg-white px-2 py-1 text-2xs font-bold text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200 disabled:opacity-50"
                        >
                          {LEAVE_REVIEW_STATUSES.map((status) => (
                            <option key={status} value={status}>{status}</option>
                          ))}
                        </select>
                      )}
                    </div>
                  </div>
                ))}
                <Pagination {...pager} noun="requests" />
              </div>
            )}
            {setStatus.error && (
              <div className="flex items-start gap-2 text-xs text-red-600 dark:text-red-300">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>{setStatus.error.message}</span>
              </div>
            )}
          </div>
        </div>

        {/* right column: form or holidays */}
        <div className="order-first lg:order-none lg:col-span-1">
          {showForm && canApply ? (
            <div className="premium-card space-y-4 animate-fade-in">
              <div className="flex justify-between items-center border-b border-neutral-100 dark:border-neutral-900 pb-2.5">
                <h3 className="font-bold text-xs uppercase tracking-wider text-neutral-800 dark:text-neutral-150">Apply for Leave</h3>
                <button onClick={() => setShowForm(false)} className="p-1 hover:bg-neutral-100 dark:hover:bg-neutral-900 rounded text-neutral-450 cursor-pointer"><X size={15} /></button>
              </div>
              <form onSubmit={submit} className="space-y-3.5 text-xs">
                <div className="space-y-1">
                  <label className="text-neutral-500 font-semibold uppercase text-2xs tracking-wider">Leave Type</label>
                  <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}
                    className="w-full bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 rounded-xl px-3.5 py-2 focus:outline-none focus:border-black dark:focus:border-[#0ea971] cursor-pointer font-medium">
                    {LEAVE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-neutral-500 font-semibold uppercase text-2xs tracking-wider">Start</label>
                    <input type="date" required value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })}
                      className="w-full bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-855 rounded-xl px-3 py-1.5 focus:outline-none focus:border-black dark:focus:border-[#0ea971]" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-neutral-500 font-semibold uppercase text-2xs tracking-wider">End</label>
                    <input type="date" required value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })}
                      className="w-full bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-855 rounded-xl px-3 py-1.5 focus:outline-none focus:border-black dark:focus:border-[#0ea971]" />
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-neutral-500 font-semibold uppercase text-2xs tracking-wider">Reason</label>
                  <textarea required rows={3} placeholder="Reason for time-off…" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}
                    className="w-full bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 rounded-xl px-3.5 py-2 focus:outline-none focus:border-black dark:focus:border-[#0ea971] resize-none" />
                </div>
                {apply.error && <p className="text-xs text-red-500">{apply.error.message}</p>}
                <div className="flex space-x-2.5 pt-2 border-t border-neutral-100 dark:border-neutral-900">
                  <button type="button" onClick={() => setShowForm(false)} className="flex-1 py-2 bg-neutral-100 dark:bg-neutral-900 hover:bg-neutral-200 dark:hover:bg-neutral-800 text-neutral-700 dark:text-neutral-450 font-medium rounded-xl cursor-pointer border border-neutral-200 dark:border-neutral-800">Cancel</button>
                  <button type="submit" disabled={apply.isPending} className={btnClass('primary')}>
                    {apply.isPending && <Loader2 size={13} className="animate-spin" />} Submit
                  </button>
                </div>
              </form>
            </div>
          ) : (
            <div className="premium-card space-y-4 animate-fade-in">
              <h3 className="font-bold text-xs uppercase tracking-wider text-neutral-800 dark:text-neutral-100 border-b border-neutral-100 dark:border-neutral-900 pb-2.5 flex items-center">
                <Calendar size={16} className="mr-2 text-neutral-600 dark:text-neutral-400" /> Holiday Calendar
              </h3>
              <div className="space-y-2.5 max-h-[300px] overflow-y-auto pr-1">
                {holidays.map((h) => {
                  const [y, mo, d] = h.holiday_date.slice(0, 10).split('-').map(Number);
                  const dt = new Date(Date.UTC(y, mo - 1, d));
                  return (
                    <div key={h.id} className="p-3 bg-neutral-50 dark:bg-neutral-950/20 border border-neutral-200 dark:border-neutral-850 rounded-xl flex justify-between items-center text-xs">
                      <div>
                        <span className="font-semibold text-neutral-700 dark:text-slate-350 block">
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
                {holidays.length === 0 && (
                  <p className="py-6 text-center text-xs text-neutral-500">
                    No holidays set for {currentYear} yet — add them in Attendance Setup.
                  </p>
                )}
              </div>
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
