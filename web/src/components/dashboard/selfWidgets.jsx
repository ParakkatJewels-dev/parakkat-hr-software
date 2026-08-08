// Self-service ("my day") widgets. Used as the whole dashboard for ESS employees and as a
// collapsible section for managers who also have an employee record.
//
// RLS already limits an ESS user's queries to their own rows, but managers see their whole scope
// through the same hooks — so every widget here ALSO filters client-side to the signed-in
// employee. That filter is presentational, not a security boundary.
import React, { useState } from 'react';
import {
  Clock, CalendarDays, ReceiptText, LifeBuoy, ListChecks, Wallet, CheckCircle2,
  ChevronDown, ChevronRight, UserRound, CalendarCheck2, ArrowRight, Fingerprint,
} from 'lucide-react';
import { useAuth } from '../../auth/AuthContext';
import { useDayAttendance, useMonthlyAttendance, todayIso, fmtTime, fmtMinutes, STATUS_STYLES } from '../../data/attendance';
import { useLeaveBalances } from '../../data/leaveTypes';
import { useLeaves } from '../../data/leaves';
import { useExpenses } from '../../data/expenses';
import { useTickets } from '../../data/tickets';
import { useMyRegularizations } from '../../data/regularizations';
import { useTasks, useUpdateTask } from '../../data/tasks';
import { usePayslips } from '../../data/payroll';
import { Widget, EmptyNote, StatPill, StatusBadge, fmtDay, inr } from './shared';

/** Is this row (with an `employee` join) the signed-in person's own record? */
const isMine = (row, me) => {
  const emp = row.employee;
  if (!emp || !me) return false;
  if (emp.id && me.id) return emp.id === me.id;
  if (emp.employee_code && me.employee_code) return emp.employee_code === me.employee_code;
  return emp.full_name === me.full_name;
};

/** The employee landing panel: one glance, the next useful action, and no admin noise. */
export function EmployeeTodayHero({ onNavigate }) {
  const { employee } = useAuth();
  const today = todayIso();
  const { data: rows = [], isLoading } = useDayAttendance(today);
  const { data: balances = [] } = useLeaveBalances(employee?.id, Number(today.slice(0, 4)));
  const { data: tasks = [] } = useTasks();
  const { data: payslips = [] } = usePayslips();

  const row = rows.find((r) => r.employee?.id === employee?.id);
  const openTasks = tasks.filter((t) => t.employee_id === employee?.id && t.status !== 'Done' && t.status !== 'Cancelled').length;
  const availableLeave = balances.reduce((n, b) => n + Number(b.available || 0), 0);
  const latestPayslip = payslips.filter((p) => isMine(p, employee))[0];
  const dateLabel = new Date().toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  const punchState = (() => {
    if (isLoading) return { title: 'Loading today', detail: 'Checking your attendance status.', tone: 'neutral', action: 'Open attendance' };
    if (!row) return { title: 'Ready to start', detail: 'No attendance record for today yet.', tone: 'amber', action: 'Open attendance' };
    if (row.is_missing_punch) return { title: 'Punch needs attention', detail: 'One punch looks incomplete today.', tone: 'amber', action: 'Regularize' };
    if (row.check_in && !row.check_out) return { title: 'You are checked in', detail: `Started at ${fmtTime(row.check_in)}.`, tone: 'green', action: 'View day' };
    if (row.check_out) return { title: 'Day recorded', detail: `Worked ${fmtMinutes(row.worked_minutes)} today.`, tone: 'green', action: 'View day' };
    return { title: row.status || 'Today', detail: 'Attendance is being computed.', tone: 'neutral', action: 'Open attendance' };
  })();

  const metrics = [
    { label: 'Check-in', value: row?.check_in ? fmtTime(row.check_in) : '—', tab: 'attendance' },
    { label: 'Worked', value: row?.worked_minutes ? fmtMinutes(row.worked_minutes) : '—', tab: 'attendance' },
    { label: 'Leave left', value: availableLeave, tab: 'leave' },
    { label: 'Tasks', value: openTasks, tab: 'tasks' },
  ];

  const actions = [
    { label: punchState.action, tab: 'attendance', icon: Fingerprint, primary: true },
    { label: 'Apply leave', tab: 'leave', icon: CalendarDays },
    { label: latestPayslip ? 'Payslip' : 'Pay', tab: 'payroll', icon: Wallet },
    { label: 'Help', tab: 'helpdesk', icon: LifeBuoy },
  ];

  return (
    <section className="premium-card employee-today-hero" data-tone={punchState.tone}>
      <div className="employee-today-copy">
        <div className="employee-today-meta">
          <span>My workspace</span>
          <span>{dateLabel}</span>
        </div>
        <h1>{punchState.title}</h1>
        <p>{punchState.detail}</p>
      </div>

      <div className="employee-today-metrics">
        {metrics.map((m) => (
          <button key={m.label} type="button" onClick={() => onNavigate?.(m.tab)}>
            <span>{m.label}</span>
            <strong>{m.value}</strong>
          </button>
        ))}
      </div>

      <div className="employee-today-actions">
        {actions.map(({ label, tab, icon: Icon, primary }) => (
          <button
            key={label}
            type="button"
            data-primary={primary ? 'true' : 'false'}
            onClick={() => onNavigate?.(tab)}
          >
            <Icon size={15} />
            <span>{label}</span>
            {primary && <ArrowRight size={13} />}
          </button>
        ))}
      </div>
    </section>
  );
}

/** Today's punch status: check-in/out, shift, worked time, late flag. */
export function PunchCard({ onNavigate }) {
  const { employee } = useAuth();
  const { data: rows = [], isLoading } = useDayAttendance(todayIso());
  const row = rows.find((r) => r.employee?.id === employee?.id);

  return (
    <Widget title="Today" icon={Clock} action="Attendance" onAction={() => onNavigate?.('attendance')}>
      {isLoading ? (
        <EmptyNote>Loading…</EmptyNote>
      ) : !row ? (
        <EmptyNote>No attendance record for today yet.</EmptyNote>
      ) : (
        <div className="space-y-3">
          <div className="mobile-list-row flex items-center justify-between">
            <span className={`text-2xs font-bold px-2 py-1 rounded-lg ${STATUS_STYLES[row.status] || 'bg-neutral-150 text-neutral-600'}`}>
              {row.status}
            </span>
            {row.shift && (
              <span className="text-2xs font-mono text-neutral-500 dark:text-neutral-400">
                {row.shift.name} · {String(row.shift.start_time).slice(0, 5)}–{String(row.shift.end_time).slice(0, 5)}
              </span>
            )}
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            {[
              { label: 'Check-in', value: fmtTime(row.check_in) },
              { label: 'Check-out', value: fmtTime(row.check_out) },
              { label: 'Worked', value: fmtMinutes(row.worked_minutes) },
            ].map(({ label, value }) => (
              <div key={label} className="rounded-xl border border-neutral-200/70 dark:border-neutral-850 py-2">
                <p className="text-sm font-bold font-mono text-neutral-900 dark:text-white leading-none">{value}</p>
                <p className="mt-1 text-xs font-bold uppercase tracking-wider text-neutral-450 dark:text-neutral-500">{label}</p>
              </div>
            ))}
          </div>
          {(row.is_late || row.is_missing_punch) && (
            <div className="mobile-list-row flex items-center justify-between gap-2 rounded-lg bg-amber-500/10 px-2.5 py-1.5">
              <span className="text-2xs font-semibold text-amber-600 dark:text-amber-400">
                {row.is_missing_punch ? 'Missing punch today' : `Late by ${fmtMinutes(row.late_minutes)}`}
              </span>
              <button
                onClick={() => onNavigate?.('attendance')}
                className="text-2xs font-bold text-amber-700 dark:text-amber-300 hover:underline cursor-pointer shrink-0"
              >
                Regularize
              </button>
            </div>
          )}
        </div>
      )}
    </Widget>
  );
}

/** Current-month attendance summary for the signed-in employee. */
export function MyMonthCard({ onNavigate }) {
  const { employee } = useAuth();
  const today = todayIso();
  const [year, month] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  const { data: rows = [] } = useMonthlyAttendance(employee?.id, year, month);

  const c = rows.reduce(
    (acc, r) => {
      if (r.status === 'Present') acc.present += 1;
      if (r.status === 'Half Day') acc.half += 1;
      if (r.status === 'Absent') acc.absent += 1;
      if (r.status === 'On Leave') acc.leave += 1;
      if (r.is_late) acc.late += 1;
      if (r.is_missing_punch) acc.missing += 1;
      return acc;
    },
    { present: 0, half: 0, absent: 0, leave: 0, late: 0, missing: 0 }
  );

  return (
    <Widget title="This Month" icon={CalendarCheck2} action="Attendance" onAction={() => onNavigate?.('attendance')}>
      {rows.length === 0 ? (
        <EmptyNote>No attendance computed yet this month.</EmptyNote>
      ) : (
        <div className="grid grid-cols-2 gap-1.5">
          <StatPill label="Present" value={c.present} tone="green" onClick={() => onNavigate?.('attendance')} />
          <StatPill label="Half days" value={c.half} tone="amber" onClick={() => onNavigate?.('attendance')} />
          <StatPill label="Absent" value={c.absent} tone="red" onClick={() => onNavigate?.('attendance')} />
          <StatPill label="On leave" value={c.leave} tone="blue" onClick={() => onNavigate?.('leave')} />
          <StatPill label="Late marks" value={c.late} tone="amber" onClick={() => onNavigate?.('attendance')} />
          <StatPill label="Missing punch" value={c.missing} tone="violet" onClick={() => onNavigate?.('attendance')} />
        </div>
      )}
    </Widget>
  );
}

/** Leave balance per type with an apply shortcut. */
export function MyLeaveBalances({ onNavigate }) {
  const { employee } = useAuth();
  const year = Number(todayIso().slice(0, 4));
  const { data: balances = [] } = useLeaveBalances(employee?.id, year);

  return (
    <Widget title="Leave Balances" icon={CalendarDays} action="Apply" onAction={() => onNavigate?.('leave')}>
      {balances.length === 0 ? (
        <EmptyNote>No balances set up for {year} yet.</EmptyNote>
      ) : (
        <div className="space-y-1.5">
          {balances.map((b) => {
            const total = Number(b.entitled) + Number(b.carried_forward || 0);
            const pct = total > 0 ? Math.max(0, Math.min(100, (Number(b.available) / total) * 100)) : 0;
            return (
              <button
                key={b.id}
                onClick={() => onNavigate?.('leave')}
                className="w-full text-left rounded-lg border border-neutral-200/60 dark:border-neutral-850 px-2.5 py-2 cursor-pointer hover:border-[#0ea971]/40 transition-colors"
              >
                <div className="mobile-list-row flex items-center justify-between">
                  <span className="text-base font-semibold text-neutral-700 dark:text-warm-gray-200 truncate">
                    {b.leave_type?.name || b.leave_type?.code}
                  </span>
                  <span className="text-2xs font-mono font-bold text-neutral-600 dark:text-neutral-300 shrink-0">
                    {b.available}/{total}
                  </span>
                </div>
                <div className="mt-1.5 h-1 rounded-full bg-neutral-150 dark:bg-charcoal-800 overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${pct}%`, backgroundColor: b.leave_type?.colour || '#0ea971' }}
                  />
                </div>
              </button>
            );
          })}
        </div>
      )}
    </Widget>
  );
}

/** One tracker for everything I've requested: leaves, expenses, tickets, regularizations. */
export function MyRequests({ onNavigate }) {
  const { employee } = useAuth();
  const { data: leaves = [] } = useLeaves();
  const { data: expenses = [] } = useExpenses();
  const { data: tickets = [] } = useTickets();
  const { data: regs = [] } = useMyRegularizations(employee?.id);

  const items = [
    ...leaves.filter((l) => isMine(l, employee)).map((l) => ({
      key: `l-${l.id}`, icon: CalendarDays, tab: 'leave', status: l.status,
      label: `${l.type} leave · ${l.days} day${l.days > 1 ? 's' : ''}`, sub: `${fmtDay(l.start_date)} – ${fmtDay(l.end_date)}`,
      created: l.created_at,
    })),
    ...expenses.filter((e) => isMine(e, employee)).map((e) => ({
      key: `e-${e.id}`, icon: ReceiptText, tab: 'expense', status: e.status,
      label: `${e.category} · ${inr(e.amount)}`, sub: fmtDay(e.expense_date), created: e.created_at,
    })),
    ...tickets.filter((t) => isMine(t, employee)).map((t) => ({
      key: `t-${t.id}`, icon: LifeBuoy, tab: 'helpdesk', status: t.status,
      label: t.subject, sub: t.category, created: t.created_at,
    })),
    ...regs.map((r) => ({
      key: `r-${r.id}`, icon: Clock, tab: 'attendance', status: r.status,
      label: `Regularization · ${fmtDay(r.work_date)}`, sub: r.reason, created: r.created_at,
    })),
  ]
    .sort((a, b) => new Date(b.created) - new Date(a.created))
    .slice(0, 6);

  return (
    <Widget title="My Requests" icon={ListChecks} action="Requests" onAction={() => onNavigate?.('leave')}>
      {items.length === 0 ? (
        <EmptyNote>Nothing raised yet — leaves, expenses and tickets will show up here.</EmptyNote>
      ) : (
        <div className="space-y-1.5">
          {items.map(({ key, icon: Icon, tab, status, label, sub }) => (
            <button
              key={key}
              onClick={() => onNavigate?.(tab)}
              className="w-full flex items-center gap-2.5 rounded-lg border border-neutral-200/60 dark:border-neutral-850 px-2.5 py-1.5 text-left hover:border-neutral-350 dark:hover:border-neutral-800 transition-colors cursor-pointer"
            >
              <Icon size={12} className="text-neutral-400 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block text-base font-semibold text-neutral-700 dark:text-warm-gray-200 truncate">{label}</span>
                <span className="block text-2xs text-neutral-450 dark:text-neutral-500 truncate">{sub}</span>
              </span>
              <StatusBadge status={status} />
            </button>
          ))}
        </div>
      )}
    </Widget>
  );
}

/** My open tasks, overdue first, with inline complete. */
export function MyTasks({ onNavigate }) {
  const { employee } = useAuth();
  const { data: tasks = [] } = useTasks();
  const updateTask = useUpdateTask();
  const today = todayIso();

  const mine = tasks
    .filter((t) => t.employee_id === employee?.id && t.status !== 'Done' && t.status !== 'Cancelled')
    .sort((a, b) => (a.due_date || '9999') < (b.due_date || '9999') ? -1 : 1)
    .slice(0, 5);

  return (
    <Widget title="My Tasks" icon={CheckCircle2} badge={mine.length || null} action="All tasks" onAction={() => onNavigate?.('tasks')}>
      {mine.length === 0 ? (
        <EmptyNote>No open tasks. Enjoy the calm.</EmptyNote>
      ) : (
        <div className="space-y-1.5">
          {mine.map((t) => {
            const overdue = t.due_date && t.due_date < today;
            return (
              <div key={t.id} className="mobile-list-row flex items-center gap-2.5 rounded-lg border border-neutral-200/60 dark:border-neutral-850 px-2.5 py-1.5">
                <button
                  onClick={() => updateTask.mutate({ id: t.id, status: 'Done' })}
                  title="Mark done" aria-label="Mark done"
                  className="w-4 h-4 rounded border border-neutral-300 dark:border-neutral-700 hover:border-[#0ea971] hover:bg-[#0ea971]/10 transition-colors cursor-pointer shrink-0"
                />
                <button
                  onClick={() => onNavigate?.('tasks')}
                  className="min-w-0 flex-1 text-left cursor-pointer"
                  title="Open task board" aria-label="Open task board"
                >
                  <span className="block text-base font-semibold text-neutral-700 dark:text-warm-gray-200 truncate">{t.title}</span>
                  {t.due_date && (
                    <span className={`block text-2xs truncate ${overdue ? 'text-rose-500 font-bold' : 'text-neutral-450 dark:text-neutral-500'}`}>
                      {overdue ? 'Overdue · ' : 'Due '}{fmtDay(t.due_date)}
                    </span>
                  )}
                </button>
                <span className="text-2xs font-mono text-neutral-400 shrink-0">{t.priority}</span>
              </div>
            );
          })}
        </div>
      )}
    </Widget>
  );
}

/** Latest payslip summary. */
export function MyPayslip({ onNavigate }) {
  const { employee } = useAuth();
  const { data: payslips = [] } = usePayslips();
  const mine = payslips.filter((p) => isMine(p, employee));
  const latest = mine[0];

  return (
    <Widget title="Latest Payslip" icon={Wallet} action="Payroll" onAction={() => onNavigate?.('payroll')}>
      {!latest ? (
        <EmptyNote>No payslips published yet.</EmptyNote>
      ) : (
        <button
          onClick={() => onNavigate?.('payroll')}
          className="mobile-list-row w-full flex items-center justify-between rounded-xl border border-neutral-200/70 dark:border-neutral-850 px-3 py-2.5 text-left cursor-pointer hover:border-[#0ea971]/40 transition-colors"
        >
          <div>
            <p className="text-base font-bold text-neutral-800 dark:text-warm-gray-100">{latest.period}</p>
            <p className="text-2xs text-neutral-450 dark:text-neutral-500 mt-0.5">
              Gross {inr(latest.gross)} · Deductions {inr(latest.deductions)}
            </p>
          </div>
          <div className="text-right">
            <p className="text-sm font-bold font-mono text-neutral-900 dark:text-white">{inr(latest.net)}</p>
            <StatusBadge status={latest.status} />
          </div>
        </button>
      )}
    </Widget>
  );
}

/**
 * Collapsible "My self-service" block for managers/admins who also have an employee record.
 * ESS users never see this — their whole dashboard IS the self-service view.
 */
export function EssSection({ onNavigate }) {
  const { employee } = useAuth();
  const [open, setOpen] = useState(false);
  if (!employee) return null;

  return (
    <section className="space-y-4">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-2xs font-bold uppercase tracking-[0.12em] text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors cursor-pointer"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <UserRound size={12} />
        My self-service
      </button>
      {open && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-4 animate-fade-in">
          <PunchCard onNavigate={onNavigate} />
          <MyLeaveBalances onNavigate={onNavigate} />
          <MyRequests onNavigate={onNavigate} />
          <MyTasks onNavigate={onNavigate} />
        </div>
      )}
    </section>
  );
}
