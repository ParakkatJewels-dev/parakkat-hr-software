// Self-service ("my day") widgets. Used as the whole dashboard for ESS employees and as a
// collapsible section for managers who also have an employee record.
//
// RLS already limits an ESS user's queries to their own rows, but managers see their whole scope
// through the same hooks — so every widget here ALSO filters client-side to the signed-in
// employee. That filter is presentational, not a security boundary.
import React, { useState } from 'react';
import { Skeleton, SkeletonRows } from '../ui/Skeleton';
import {
  Clock, CalendarDays, ReceiptText, LifeBuoy, ListChecks, Wallet,
  ChevronDown, ChevronRight, UserRound, CalendarCheck2, ArrowRight, Check, Loader2,
  Umbrella, ShieldPlus, CalendarHeart, IdCard, Building2, MapPin, Mail, Phone } from 'lucide-react';
import { useEmployee } from '../../data/employees';
import { initialsOf } from '../ui/Avatar';
import { useAuth } from '../../auth/AuthContext';
import { usePermissions } from '../../auth/usePermissions';
import { useDayAttendance, useMonthlyAttendance, todayIso, fmtTime, fmtMinutes } from '../../data/attendance';
import { useLeaveBalances } from '../../data/leaveTypes';
import { useLeaves } from '../../data/leaves';
import { useExpenses } from '../../data/expenses';
import { useTickets } from '../../data/tickets';
import { useMyRegularizations } from '../../data/regularizations';
import { useTasks, useUpdateTask } from '../../data/tasks';
import { usePayslips } from '../../data/payroll';
import { useRoutineDay, useSetRoutineTick } from '../../data/routines';
import { routineProgress } from '../../lib/routines';
import { useIstToday } from '../../lib/useIstToday';
import { checklistProgress } from '../../lib/checklist';
import { humanDbError } from '../../lib/dbErrors';
import { isAssignedTo } from '../../lib/taskBoard';
import { Widget, EmptyNote, StatPill, StatusBadge, fmtDay, inr } from './shared';
import './selfWidgets.css';

/** Is this row (with an `employee` join) the signed-in person's own record? */
const isMine = (row, me) => {
  const emp = row.employee;
  if (!emp || !me) return false;
  if (emp.id && me.id) return emp.id === me.id;
  if (emp.employee_code && me.employee_code) return emp.employee_code === me.employee_code;
  return emp.full_name === me.full_name;
};

/**
 * Today at work (2026 redesign): the coral card that opens the self-service home — where today's
 * attendance stands, the time you checked in, and the way to the full record.
 */
export function TodayAtWork({ onNavigate }) {
  const { employee } = useAuth();
  const { data: rows = [], isLoading } = useDayAttendance(todayIso());
  const row = rows.find((r) => r.employee?.id === employee?.id);

  const state = (() => {
    if (!row) return { chip: 'Not checked in', label: 'No punch recorded yet', time: '—', action: 'View attendance', tab: 'attendance' };
    if (row.is_missing_punch) return { chip: 'Needs attention', label: 'A punch looks incomplete', time: fmtTime(row.check_in), action: 'Fix attendance', tab: 'attendance/regularizations' };
    if (row.check_out) return { chip: 'Day recorded', label: `Worked ${fmtMinutes(row.worked_minutes)}`, time: fmtTime(row.check_in), action: 'View attendance', tab: 'attendance', good: true };
    if (row.check_in) return { chip: 'Checked in', label: 'Checked in at', time: fmtTime(row.check_in), action: 'View attendance', tab: 'attendance', good: true };
    return { chip: row.status || 'Today', label: 'Attendance is being worked out', time: '—', action: 'View attendance', tab: 'attendance' };
  })();
  const where = [row?.shift?.name, 'Today'].filter(Boolean).join(' · ');

  return (
    <section className="today-at-work" aria-label="Today at work">
      <header>
        <h3>Today at work</h3>
        {!isLoading && <span className="today-at-work-chip" data-good={state.good ? 'true' : 'false'}><span aria-hidden="true" />{state.chip}</span>}
      </header>
      <div className="today-at-work-main">
        <span className="today-at-work-clock" aria-hidden="true"><Clock size={34} strokeWidth={2.2} /></span>
        {isLoading ? <Skeleton className="h-12 w-40 bg-white/30" /> : (
          <div className="today-at-work-time">
            <span>{state.label}</span>
            <strong>{state.time}</strong>
            <small>{where}</small>
          </div>
        )}
      </div>
      <button type="button" className="today-at-work-action" onClick={() => onNavigate?.(state.tab)}>
        {state.action} <ArrowRight size={16} aria-hidden="true" />
      </button>
    </section>
  );
}

/** My profile at a glance, from the employee record (2026 redesign). */
export function MyProfileCard({ onNavigate }) {
  const { employee, user } = useAuth();
  const { data: record } = useEmployee(employee?.id, { enabled: Boolean(employee?.id) });
  const person = record ?? employee;
  if (!person) return null;
  const rows = [
    [IdCard, 'Employee ID', person.employee_code],
    [Building2, 'Department', record?.department?.name],
    [MapPin, 'Location', record?.branch?.name || record?.branch?.code],
    [Mail, 'Work email', person.email || user?.email],
    [Phone, 'Phone', record?.phone],
  ].filter(([, , value]) => value);
  return (
    <Widget title="My profile" action="View profile" onAction={() => onNavigate?.('profile')}>
      <div className="my-profile-head">
        <span className="my-profile-avatar" aria-hidden="true">{initialsOf(person.full_name)}</span>
        <div className="min-w-0">
          <p className="my-profile-name">{person.full_name}</p>
          <p className="my-profile-role">{record?.designation?.title || record?.designation?.name || 'Employee'}</p>
        </div>
      </div>
      <dl className="my-profile-rows">
        {rows.map(([Icon, label, value]) => (
          <div key={label}>
            <dt><Icon size={15} aria-hidden="true" />{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
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

const LEAVE_TILE = [
  { tone: 'green', icon: Umbrella }, { tone: 'blue', icon: ShieldPlus }, { tone: 'red', icon: CalendarHeart },
  { tone: 'violet', icon: CalendarDays },
];

/** Leave balance per type as tiles, with an apply shortcut (2026 redesign). */
export function MyLeaveBalances({ onNavigate }) {
  const { employee } = useAuth();
  const year = Number(todayIso().slice(0, 4));
  const { data: balances = [] } = useLeaveBalances(employee?.id, year);

  return (
    <Widget title="Leave balance" action="View all" onAction={() => onNavigate?.('leave')}>
      {balances.length === 0 ? (
        <EmptyNote>No balances set up for {year} yet.</EmptyNote>
      ) : (
        <div className="leave-tiles">
          {balances.slice(0, 3).map((b, i) => {
            const total = Number(b.entitled) + Number(b.carried_forward || 0);
            const { tone, icon: Icon } = LEAVE_TILE[i % LEAVE_TILE.length];
            return (
              <button key={b.id} type="button" onClick={() => onNavigate?.('leave')} className="leave-tile" data-tone={tone}>
                <Icon size={22} aria-hidden="true" />
                <span className="leave-tile-name">{b.leave_type?.name || b.leave_type?.code}</span>
                <strong>{b.available}</strong>
                <span className="leave-tile-left">days left</span>
                <span className="leave-tile-of">of {total} days</span>
              </button>
            );
          })}
        </div>
      )}
      <button type="button" className="leave-apply" onClick={() => onNavigate?.('leave')}>
        <CalendarDays size={17} aria-hidden="true" /> Apply for leave <ArrowRight size={16} aria-hidden="true" />
      </button>
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
    <Widget title="My requests" action="View all" onAction={() => onNavigate?.('leave')}>
      {items.length === 0 ? (
        <EmptyNote>Nothing raised yet — leaves, expenses and tickets will show up here.</EmptyNote>
      ) : (
        <div className="space-y-1.5">
          {items.map(({ key, icon: Icon, tab, status, label, sub }) => (
            <button key={key} type="button" onClick={() => onNavigate?.(tab)} className="home-list-row">
              <span className="home-list-icon" aria-hidden="true"><Icon size={18} /></span>
              <span className="home-list-copy">
                <strong>{label}</strong>
                <span>{sub}</span>
              </span>
              <StatusBadge status={status} />
              <ChevronRight size={16} className="home-list-chevron" aria-hidden="true" />
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
  const { can } = usePermissions();
  const { data: tasks = [], isLoading, error } = useTasks();
  const updateTask = useUpdateTask();
  const today = useIstToday();

  const mine = tasks
    .filter((t) => isAssignedTo(t, employee?.id) && t.status !== 'Done' && t.status !== 'Cancelled')
    .sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999') || String(a.id).localeCompare(String(b.id)));
  const openTasks = () => onNavigate?.('tasks/todo');

  return (
    <Widget title="My tasks" className="home-work-widget" badge={mine.length || null} action="View all" onAction={openTasks}>
      {(error || updateTask.error) && <p role="alert" className="home-work-error">{humanDbError(updateTask.error || error, 'tasks')}</p>}
      {isLoading ? <SkeletonRows rows={3} compact avatar={false} label="Loading your tasks" /> : mine.length === 0 && !error ? (
        <EmptyNote>No open tasks. Enjoy the calm.</EmptyNote>
      ) : (
        <div className="home-work-list">
          {mine.slice(0, 5).map((t) => {
            const overdue = t.due_date && t.due_date < today;
            const checklist = checklistProgress(t.checklist ?? []);
            const needsSteps = checklist.total > 0 && !checklist.allDone;
            const taskScope = { employeeId: employee?.id, entityId: t.entity_id, zoneId: t.zone_id, branchId: t.branch_id, deptId: t.department_id };
            const canComplete = can('task.update', taskScope) || can('task.manage', taskScope);
            return (
              <div key={t.id} className="home-work-row">
                <button
                  type="button" disabled={!canComplete || updateTask.isPending}
                  onClick={() => needsSteps ? openTasks() : updateTask.mutate({ id: t.id, status: 'Done' })}
                  title={needsSteps ? 'Complete the subtasks first' : 'Mark done'}
                  aria-label={needsSteps ? `Open subtasks for ${t.title}` : `Mark "${t.title}" done`}
                  className="home-work-check"
                >
                  {updateTask.isPending && updateTask.variables?.id === t.id ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                </button>
                <button
                  type="button" onClick={openTasks}
                  className="home-work-copy"
                  aria-label={`Open ${t.title} in My tasks`}
                >
                  <span className="home-work-title">{t.title}</span>
                  <span className="home-work-meta">
                    <span>{t.priority}</span>
                    {t.due_date && (
                      <span className={overdue ? 'home-work-overdue' : ''}>
                        {overdue ? 'Overdue · ' : t.due_date === today ? '' : 'Due '}{t.due_date === today ? 'Today' : fmtDay(t.due_date)}
                      </span>
                    )}
                    {checklist.total > 0 && <span>{checklist.done}/{checklist.total} subtasks</span>}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      )}
      {mine.length > 5 && <button type="button" onClick={openTasks} className="home-work-more">View all {mine.length} tasks <ArrowRight size={13} /></button>}
    </Widget>
  );
}

/** Today's scheduled jobs, including weekly/monthly routines when their due date arrives. */
export function MyRoutineToday({ onNavigate }) {
  const { employee } = useAuth();
  const { can, canAny } = usePermissions();
  const today = useIstToday();
  const enabled = Boolean(employee?.id && canAny('task.read'));
  const dayQuery = useRoutineDay(today, { enabled, employeeId: employee?.id });
  const setTick = useSetRoutineTick();
  const items = (dayQuery.data ?? []).filter((item) => item.employee_id === employee?.id);
  const progress = routineProgress(items);
  const error = dayQuery.error || setTick.error;
  const loading = dayQuery.isLoading;
  const canTick = can('task.update', { employeeId: employee?.id, entityId: employee?.entity_id, zoneId: employee?.zone_id, branchId: employee?.branch_id, deptId: employee?.department_id });

  if (!enabled || (!loading && !error && !setTick.isPending && (progress.complete || items.length === 0))) return null;

  return (
    <Widget title="My routine today" className="home-work-widget home-routine" icon={ListChecks}
      badge={loading ? null : `${progress.done}/${progress.total}`} action="Routine" onAction={() => onNavigate?.('tasks/routine?routineView=mine')}>
      {error && <div role="alert" className="home-work-error">
        <p>{humanDbError(error, 'routine_ticks')}</p>
        {dayQuery.error && <button type="button" onClick={() => dayQuery.refetch()}>Try again</button>}
      </div>}
      {loading ? <SkeletonRows rows={3} compact avatar={false} trailing={false} label="Loading today’s routine" /> : <>
        <p className="home-routine-note">{fmtDay(today)} · {progress.total - progress.done} remaining</p>
        <div className="home-routine-list">
          {items.filter(item => !item.done).slice(0, 6).map(item => (
            <button key={item.id} type="button" className="home-routine-item" disabled={!canTick || item.can_tick !== true || setTick.isPending || Boolean(dayQuery.error)}
              aria-label={`Complete routine: ${item.title}`}
              onClick={() => setTick.mutate({ itemId: item.id, employeeId: employee.id, onDate: today, done: true })}>
              <span className="home-routine-checkbox" aria-hidden="true">
                {setTick.isPending && setTick.variables?.itemId === item.id ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
              </span>
              <span className="home-work-copy"><span className="home-work-title">{item.title}</span>
                {item.routine_name && <span className="home-work-meta">{item.routine_name}</span>}
                {item.detail && <span className="home-work-meta">{item.detail}</span>}
              </span>
            </button>
          ))}
        </div>
        {progress.total - progress.done > 6 && <button type="button" className="home-work-more" onClick={() => onNavigate?.('tasks/routine?routineView=mine')}>View all remaining duties <ArrowRight size={13} /></button>}
        {canTick && !dayQuery.error && <button type="button" className="home-work-more" onClick={() => onNavigate?.('tasks/routine?routineView=mine')}>Add a note about unfinished work <ArrowRight size={13} /></button>}
      </>}
    </Widget>
  );
}

/** Latest payslip summary. */
export function MyPayslip({ onNavigate }) {
  const { employee } = useAuth();
  const { data: payslips = [] } = usePayslips(employee?.id, { enabled: Boolean(employee?.id) });
  const mine = payslips.filter((p) => isMine(p, employee));
  const latest = mine[0];

  return (
    <Widget title="Latest Payslip" icon={Wallet} action="Payroll" onAction={() => onNavigate?.('payroll')}>
      {!latest ? (
        <EmptyNote>No payslips published yet.</EmptyNote>
      ) : (
        <button
          onClick={() => onNavigate?.('payroll')}
          className="mobile-list-row w-full flex items-center justify-between rounded-xl border border-neutral-200/70 dark:border-neutral-850 px-3 py-2.5 text-left cursor-pointer hover:border-brand/40 transition-colors"
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
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-9 items-center gap-2 text-2xs font-bold uppercase tracking-[0.12em] text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors cursor-pointer"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <UserRound size={12} />
        My self-service
      </button>
      {open && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-4 animate-fade-in">
          <TodayAtWork onNavigate={onNavigate} />
          <MyLeaveBalances onNavigate={onNavigate} />
          <MyRequests onNavigate={onNavigate} />
          <MyTasks onNavigate={onNavigate} />
        </div>
      )}
    </section>
  );
}
