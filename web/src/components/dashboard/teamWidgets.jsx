// Oversight widgets for people managers: branch managers, department heads, zonal managers.
// RLS scopes every query to the manager's grant (their branch / department / zone), so these
// widgets never filter for security — only for presentation (pending first, today only, etc.).
import React, { useState } from 'react';
import {
  Users, CalendarDays, LifeBuoy, Laptop, Check, Ban, Loader2, CalendarRange, ListChecks,
} from 'lucide-react';
import { useAuth } from '../../auth/AuthContext';
import { usePermissions } from '../../auth/usePermissions';
import { useAttendanceSummary, todayIso, fmtTime, fmtMinutes } from '../../data/attendance';
import { useLeaves, useSetLeaveStatus } from '../../data/leaves';
import { useExpenses, useSetExpenseStatus } from '../../data/expenses';
import { useRegularizations, useDecideRegularization } from '../../data/regularizations';
import { useTickets } from '../../data/tickets';
import { useAssets } from '../../data/assets';
import { useTasks } from '../../data/tasks';
import { Widget, EmptyNote, Avatar, StatPill, StatusBadge, fmtDay, inr } from './shared';

/** Live team attendance for today: counters plus who's absent / late right now. */
export function TeamAttendanceToday({ onNavigate }) {
  const { data: rows = [], summary, isLoading } = useAttendanceSummary(todayIso());

  const absent = rows.filter((r) => r.status === 'Absent');
  const late = rows.filter((r) => r.is_late);
  const missing = rows.filter((r) => r.is_missing_punch);
  const callouts = [...absent, ...missing, ...late]
    .filter((r, i, arr) => arr.findIndex((x) => x.id === r.id) === i)
    .slice(0, 6);

  return (
    <Widget
      title="Team Attendance Today"
      icon={Users}
      badge={summary.total || null}
      action="Full logs"
      onAction={() => onNavigate?.('attendance')}
    >
      {isLoading ? (
        <EmptyNote>Loading…</EmptyNote>
      ) : summary.total === 0 ? (
        <EmptyNote>No attendance rows for today yet.</EmptyNote>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-1.5">
            <StatPill label="Checked in" value={summary.checkedIn} tone="green" onClick={() => onNavigate?.('attendance')} />
            <StatPill label="Late" value={summary.late} tone="amber" onClick={() => onNavigate?.('attendance')} />
            <StatPill label="Absent" value={summary.absent} tone="red" onClick={() => onNavigate?.('attendance')} />
            <StatPill label="On leave" value={summary.onLeave} tone="blue" onClick={() => onNavigate?.('leave')} />
            <StatPill label="Missing punch" value={summary.missingPunch} tone="violet" onClick={() => onNavigate?.('attendance')} />
            <StatPill label="Off / holiday" value={summary.off} tone="neutral" onClick={() => onNavigate?.('attendance')} />
          </div>
          {callouts.length > 0 && (
            <div className="space-y-1.5">
              {callouts.map((r) => (
                <button
                  key={r.id}
                  onClick={() => onNavigate?.('attendance')}
                  className="w-full text-left flex items-center gap-2.5 rounded-lg border border-neutral-200/60 dark:border-neutral-850 px-2.5 py-1.5 cursor-pointer hover:border-[#0ea971]/40 transition-colors"
                >
                  <Avatar name={r.employee?.full_name} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-base font-semibold text-neutral-700 dark:text-warm-gray-200 truncate">
                      {r.employee?.full_name}
                    </span>
                    <span className="block text-2xs text-neutral-450 dark:text-neutral-500 truncate">
                      {r.employee?.branch?.code || r.employee?.department?.name || ''}
                      {r.check_in ? ` · in ${fmtTime(r.check_in)}` : ''}
                    </span>
                  </span>
                  <span
                    className={`text-2xs font-mono font-bold px-1.5 py-0.5 rounded border leading-none shrink-0 ${
                      r.status === 'Absent'
                        ? 'bg-rose-500/10 text-rose-500 border-rose-500/20'
                        : r.is_missing_punch
                          ? 'bg-violet-500/10 text-violet-500 border-violet-500/20'
                          : 'bg-amber-500/10 text-amber-500 border-amber-500/20'
                    }`}
                  >
                    {r.status === 'Absent' ? 'Absent' : r.is_missing_punch ? 'No punch' : `Late ${fmtMinutes(r.late_minutes)}`}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Widget>
  );
}

/**
 * The manager's inbox: pending leaves / regularizations / expenses in one tabbed queue with
 * inline approve/decline. Tabs appear only for permissions the viewer actually holds.
 */
export function ApprovalsQueue({ onNavigate }) {
  const { employee } = useAuth();
  const { canAny } = usePermissions();
  const { data: leaves = [] } = useLeaves();
  const { data: expenses = [] } = useExpenses();
  const { data: regs = [] } = useRegularizations('Pending');
  const setLeaveStatus = useSetLeaveStatus();
  const setExpenseStatus = useSetExpenseStatus();
  const decideReg = useDecideRegularization();

  // A manager shouldn't act on their own requests. Every source now selects employee.id, so
  // compare on that; a viewer with no employee record has no "own" rows to exclude.
  const notMine = (row) => !employee?.id || row.employee?.id !== employee.id;

  const tabs = [
    canAny('leave.approve') && {
      id: 'leaves',
      label: 'Leaves',
      rows: leaves.filter((l) => l.status === 'Pending' && notMine(l)),
    },
    canAny('regularization.approve') && {
      id: 'regs',
      label: 'Punches',
      rows: regs.filter((r) => notMine(r)),
    },
    canAny('expense.approve') && {
      id: 'expenses',
      label: 'Expenses',
      rows: expenses.filter((e) => e.status === 'Pending' && notMine(e)),
    },
  ].filter(Boolean);

  const [active, setActive] = useState(tabs[0]?.id);
  const tab = tabs.find((t) => t.id === active) || tabs[0];
  const total = tabs.reduce((n, t) => n + t.rows.length, 0);
  const busy = setLeaveStatus.isPending || setExpenseStatus.isPending || decideReg.isPending;

  if (tabs.length === 0) return null;

  const decide = (row, approve) => {
    if (tab.id === 'leaves') setLeaveStatus.mutate({ id: row.id, status: approve ? 'Approved' : 'Rejected' });
    else if (tab.id === 'expenses') {
      setExpenseStatus.mutate({ id: row.id, status: approve ? 'Approved' : 'Rejected', approverEmployeeId: employee?.id });
    }
    else decideReg.mutate({ id: row.id, decision: approve ? 'Approved' : 'Rejected' });
  };

  const rowTitle = (row) =>
    tab.id === 'leaves'
      ? `${row.type} · ${row.days} day${row.days > 1 ? 's' : ''}`
      : tab.id === 'expenses'
        ? `${row.category} · ${inr(row.amount)}`
        : `Punch fix · ${fmtDay(row.work_date)}`;

  const rowSub = (row) =>
    tab.id === 'leaves'
      ? `${fmtDay(row.start_date)} – ${fmtDay(row.end_date)}`
      : tab.id === 'expenses'
        ? fmtDay(row.expense_date)
        : row.reason;

  return (
    <Widget
      title="Approval Inbox"
      icon={CalendarDays}
      badge={total || null}
      action="Open queue"
      onAction={() => onNavigate?.(tab.id === 'expenses' ? 'expense' : tab.id === 'regs' ? 'attendance' : 'leave')}
    >
      <div className="mb-3 flex gap-1.5">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActive(t.id)}
            className={`rounded-lg px-2.5 py-1 text-2xs font-bold transition-colors cursor-pointer ${
              tab.id === t.id
                ? 'bg-[#0ea971]/15 text-[#0ea971] dark:text-[#10b981] border border-[#0ea971]/25'
                : 'bg-neutral-100 dark:bg-charcoal-800 text-neutral-500 dark:text-neutral-400 border border-transparent hover:text-neutral-800 dark:hover:text-warm-gray-200'
            }`}
          >
            {t.label} · {t.rows.length}
          </button>
        ))}
      </div>
      <div className="space-y-2 max-h-[340px] overflow-y-auto pr-1">
        {tab.rows.slice(0, 6).map((row) => (
          <div key={row.id} className="flex gap-2.5 p-2.5 rounded-xl border border-neutral-200/60 dark:border-neutral-850 bg-white dark:bg-charcoal-900/10">
            <Avatar name={row.employee?.full_name} />
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <span className="block text-xs font-bold text-neutral-800 dark:text-warm-gray-100 truncate">
                    {row.employee?.full_name || 'Employee'}
                  </span>
                  <span className="block text-2xs text-neutral-455 dark:text-neutral-500 mt-0.5 truncate">
                    {rowTitle(row)}
                    {row.employee?.branch?.code ? ` · ${row.employee.branch.code}` : ''}
                  </span>
                  <span className="block text-2xs text-neutral-400 dark:text-neutral-600 truncate">{rowSub(row)}</span>
                </div>
                <StatusBadge status="Pending" />
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => decide(row, true)}
                  disabled={busy}
                  className="flex items-center gap-1 rounded-lg bg-[#0ea971] hover:bg-[#0c9765] px-2.5 py-1 text-2xs font-bold text-white transition-colors cursor-pointer disabled:opacity-50"
                >
                  <Check size={10} /> Approve
                </button>
                <button
                  onClick={() => decide(row, false)}
                  disabled={busy}
                  className="flex items-center gap-1 rounded-lg border border-neutral-300/80 px-2.5 py-1 text-2xs font-semibold text-neutral-600 hover:bg-neutral-50 dark:border-neutral-800 dark:text-warm-gray-300 dark:hover:bg-charcoal-800 transition-colors cursor-pointer disabled:opacity-50"
                >
                  <Ban size={10} /> Decline
                </button>
              </div>
            </div>
          </div>
        ))}
        {busy && <div className="flex justify-center py-1 text-[#0ea971]"><Loader2 size={14} className="animate-spin" /></div>}
        {tab.rows.length === 0 && <EmptyNote>Queue is clear. Nothing pending here.</EmptyNote>}
        {tab.rows.length > 6 && (
          <button
            onClick={() => onNavigate?.(tab.id === 'expenses' ? 'expense' : tab.id === 'regs' ? 'attendance' : 'leave')}
            className="w-full text-center text-2xs font-bold text-[#0ea971] hover:underline cursor-pointer py-1"
          >
            View all {tab.rows.length}
          </button>
        )}
      </div>
    </Widget>
  );
}

/** Approved leaves overlapping the next 7 days — the coverage planner. */
export function OnLeaveThisWeek({ onNavigate }) {
  const { data: leaves = [] } = useLeaves();
  const today = todayIso();
  const weekEnd = (() => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 7);
    return d.toISOString().slice(0, 10);
  })();

  const upcoming = leaves
    .filter((l) => l.status === 'Approved' && l.start_date <= weekEnd && l.end_date >= today)
    .sort((a, b) => (a.start_date < b.start_date ? -1 : 1))
    .slice(0, 6);

  return (
    <Widget title="On Leave This Week" icon={CalendarRange} badge={upcoming.length || null} action="Leave" onAction={() => onNavigate?.('leave')}>
      {upcoming.length === 0 ? (
        <EmptyNote>Full house — nobody is on approved leave in the next 7 days.</EmptyNote>
      ) : (
        <div className="space-y-1.5">
          {upcoming.map((l) => (
            <button
              key={l.id}
              onClick={() => onNavigate?.('leave')}
              className="w-full text-left flex items-center gap-2.5 rounded-lg border border-neutral-200/60 dark:border-neutral-850 px-2.5 py-1.5 cursor-pointer hover:border-[#0ea971]/40 transition-colors"
            >
              <Avatar name={l.employee?.full_name} />
              <span className="min-w-0 flex-1">
                <span className="block text-base font-semibold text-neutral-700 dark:text-warm-gray-200 truncate">
                  {l.employee?.full_name}
                </span>
                <span className="block text-2xs text-neutral-450 dark:text-neutral-500 truncate">
                  {l.type} · {fmtDay(l.start_date)} – {fmtDay(l.end_date)}
                </span>
              </span>
              <span className="text-2xs font-mono font-bold text-neutral-500 dark:text-neutral-400 shrink-0">
                {l.days}d
              </span>
            </button>
          ))}
        </div>
      )}
    </Widget>
  );
}

/** Open helpdesk tickets in scope. */
export function TeamTickets({ onNavigate }) {
  const { data: tickets = [] } = useTickets();
  const open = tickets.filter((t) => t.status !== 'Resolved').slice(0, 5);

  return (
    <Widget title="Open Tickets" icon={LifeBuoy} badge={open.length || null} action="Helpdesk" onAction={() => onNavigate?.('helpdesk')}>
      {open.length === 0 ? (
        <EmptyNote>No open tickets in your scope.</EmptyNote>
      ) : (
        <div className="space-y-1.5">
          {open.map((t) => (
            <button
              key={t.id}
              onClick={() => onNavigate?.('helpdesk')}
              className="w-full text-left flex items-center gap-2.5 rounded-lg border border-neutral-200/60 dark:border-neutral-850 px-2.5 py-1.5 cursor-pointer hover:border-[#0ea971]/40 transition-colors"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-base font-semibold text-neutral-700 dark:text-warm-gray-200 truncate">{t.subject}</span>
                <span className="block text-2xs text-neutral-450 dark:text-neutral-500 truncate">
                  {t.employee?.full_name} · {t.category}
                </span>
              </span>
              <span
                className={`text-2xs font-mono font-bold px-1.5 py-0.5 rounded border leading-none shrink-0 ${
                  t.priority === 'High' || t.priority === 'Urgent'
                    ? 'bg-rose-500/10 text-rose-500 border-rose-500/20'
                    : 'bg-neutral-500/10 text-neutral-500 border-neutral-500/20'
                }`}
              >
                {t.priority}
              </span>
            </button>
          ))}
        </div>
      )}
    </Widget>
  );
}

/** Asset counts by status within scope. */
export function TeamAssets({ onNavigate }) {
  const { data: assets = [] } = useAssets();
  const byStatus = Object.entries(
    assets.reduce((m, a) => {
      m[a.status || 'Unknown'] = (m[a.status || 'Unknown'] || 0) + 1;
      return m;
    }, {})
  );

  return (
    <Widget title="Assets" icon={Laptop} badge={assets.length || null} action="Manage" onAction={() => onNavigate?.('assets')}>
      {assets.length === 0 ? (
        <EmptyNote>No assets recorded in your scope.</EmptyNote>
      ) : (
        <div className="grid grid-cols-2 gap-1.5">
          {byStatus.map(([status, count]) => (
            <StatPill key={status} label={status} value={count} tone={status === 'Assigned' ? 'green' : 'neutral'} onClick={() => onNavigate?.('assets')} />
          ))}
        </div>
      )}
    </Widget>
  );
}

/** Team task board summary: workload + overdue callouts. Used by dept heads. */
export function TeamTasksBoard({ onNavigate }) {
  const { data: tasks = [] } = useTasks();
  const today = todayIso();
  const active = tasks.filter((t) => t.status !== 'Done' && t.status !== 'Cancelled');
  const overdue = active.filter((t) => t.due_date && t.due_date < today).slice(0, 5);
  const counts = {
    todo: active.filter((t) => t.status === 'To Do').length,
    progress: active.filter((t) => t.status === 'In Progress').length,
    overdue: active.filter((t) => t.due_date && t.due_date < today).length,
  };

  return (
    <Widget title="Team Tasks" icon={ListChecks} badge={active.length || null} action="Board" onAction={() => onNavigate?.('tasks')}>
      <div className="grid grid-cols-3 gap-1.5 mb-3">
        <StatPill label="To do" value={counts.todo} tone="neutral" onClick={() => onNavigate?.('tasks')} />
        <StatPill label="In progress" value={counts.progress} tone="blue" onClick={() => onNavigate?.('tasks')} />
        <StatPill label="Overdue" value={counts.overdue} tone="red" onClick={() => onNavigate?.('tasks')} />
      </div>
      {overdue.length > 0 && (
        <div className="space-y-1.5">
          {overdue.map((t) => (
            <button
              key={t.id}
              onClick={() => onNavigate?.('tasks')}
              className="w-full text-left flex items-center gap-2.5 rounded-lg border border-rose-500/20 bg-rose-500/5 px-2.5 py-1.5 cursor-pointer hover:border-rose-500/40 transition-colors"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-base font-semibold text-neutral-700 dark:text-warm-gray-200 truncate">{t.title}</span>
                <span className="block text-2xs text-neutral-450 dark:text-neutral-500 truncate">
                  {t.assignee?.full_name || 'Unassigned'} · due {fmtDay(t.due_date)}
                </span>
              </span>
              <span className="text-2xs font-mono font-bold text-rose-500 shrink-0">{t.priority}</span>
            </button>
          ))}
        </div>
      )}
    </Widget>
  );
}
