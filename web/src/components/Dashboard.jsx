// Role-based dashboard.
//
// One Dashboard route, seven layout presets — picked from the user's HIGHEST role. Every widget
// gets its data through the normal RLS-scoped hooks, so the same widget shows a branch to a
// branch manager and the whole company to a super admin. Multi-role users get the preset of
// their most senior role; widgets they lack permissions for gate themselves off.
import React, { Suspense, lazy } from 'react';
import {
  Users, Building2, CalendarDays, ReceiptText, LifeBuoy, Network, ListChecks,
  Clock, Target, UserCheck, Briefcase, Shield, BarChart3, DoorOpen, UserPlus,
  Fingerprint, DollarSign, CalendarCheck2, ArrowRight,
  AlertTriangle, CheckCircle2,
} from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { usePermissions } from '../auth/usePermissions';
import { resolvePrimaryRole } from '../lib/roles';
import { useEmployees } from '../data/employees';
import { useLeaves } from '../data/leaves';
import { useExpenses } from '../data/expenses';
import { useTickets } from '../data/tickets';
import { useOrg } from '../data/org';
import { useJobs } from '../data/recruitment';
import { useExits } from '../data/exits';
import { useRegularizations } from '../data/regularizations';
import { useManagedUsers } from '../data/admin';
import { useAttendanceSummary, useMonthlyAttendance, todayIso } from '../data/attendance';
import { useLeaveBalances } from '../data/leaveTypes';
import { KpiRow, NotificationsStrip, HolidaysCard, QuickActions, inr } from './dashboard/shared';
import {
  PunchCard, MyMonthCard, MyLeaveBalances, MyRequests, MyTasks, MyPayslip, EssSection,
} from './dashboard/selfWidgets';
import {
  TeamAttendanceToday, ApprovalsQueue, OnLeaveThisWeek, TeamTickets, TeamAssets, TeamTasksBoard,
} from './dashboard/teamWidgets';
import {
  AttendanceHealthCard, OnboardingPipeline, ExitPipeline, RecruitmentOverview,
  ExpenseSpend, DocumentsSnapshot, DeviceHealth, UserAccessPanel, AuditFeed, BranchComparison,
  EntityComparison,
} from './dashboard/orgWidgets';

// recharts is the single heaviest dependency; only three presets show a chart, so it is fetched
// after paint rather than shipped to every employee.
const LazyHeadcountChart = lazy(() => import('./dashboard/HeadcountChart'));
const HeadcountChart = (props) => (
  <Suspense fallback={<div className="premium-card h-64 animate-pulse" />}>
    <LazyHeadcountChart {...props} />
  </Suspense>
);

const ROLE_TITLES = {
  super_admin: 'System Overview',
  entity_admin: 'Entity Command Center',
  hr_manager: 'People Operations',
  zonal_manager: 'Zone Overview',
  branch_manager: 'My Branch Today',
  dept_head: 'My Team',
  employee: 'My Day',
};

/* ---------------------------------- per-role KPI rows ---------------------------------- */
// Each KPI row is its own component so its queries only run for the preset that shows it.

function EssKpis({ onNavigate }) {
  const { employee } = useAuth();
  const today = todayIso();
  const [year, month] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  const { data: monthRows = [] } = useMonthlyAttendance(employee?.id, year, month);
  const { data: balances = [] } = useLeaveBalances(employee?.id, year);
  const { data: leaves = [] } = useLeaves();
  const { data: expenses = [] } = useExpenses();

  const present = monthRows.filter((r) => r.status === 'Present' || r.status === 'Half Day').length;
  const late = monthRows.filter((r) => r.is_late).length;
  const available = balances.reduce((n, b) => n + Number(b.available || 0), 0);
  const pending = leaves.filter((l) => l.status === 'Pending').length + expenses.filter((e) => e.status === 'Pending').length;

  return (
    <KpiRow
      onNavigate={onNavigate}
      kpis={[
        { label: 'Days Present', value: present, icon: CalendarCheck2, badgeClass: 'bg-[#0ea971]/10 text-[#0ea971]', subtext: 'This month', tab: 'attendance' },
        { label: 'Late Marks', value: late, icon: Clock, badgeClass: 'bg-amber-500/10 text-amber-500', subtext: 'This month', tab: 'attendance' },
        { label: 'Leave Available', value: available, icon: CalendarDays, badgeClass: 'bg-blue-500/10 text-blue-500', subtext: 'Across all types', tab: 'leave' },
        { label: 'Pending Requests', value: pending, icon: ListChecks, badgeClass: 'bg-orange-500/10 text-orange-500', subtext: 'Awaiting approval', tab: 'leave' },
      ]}
    />
  );
}

function TeamKpis({ onNavigate }) {
  const { data: employees = [] } = useEmployees();
  const { summary } = useAttendanceSummary(todayIso());
  const { data: leaves = [] } = useLeaves();
  const { data: expenses = [] } = useExpenses();
  const { data: regs = [] } = useRegularizations('Pending');

  const pendingApprovals =
    leaves.filter((l) => l.status === 'Pending').length +
    expenses.filter((e) => e.status === 'Pending').length +
    regs.length;

  return (
    <KpiRow
      onNavigate={onNavigate}
      kpis={[
        { label: 'Team Size', value: employees.filter((e) => e.status === 'Active').length, icon: Users, badgeClass: 'bg-[#0ea971]/10 text-[#0ea971]', subtext: 'Active in your scope', tab: 'directory' },
        { label: 'Checked In', value: summary.checkedIn, icon: CalendarCheck2, badgeClass: 'bg-emerald-500/10 text-emerald-500', subtext: 'Today', tab: 'attendance' },
        { label: 'Late Today', value: summary.late, icon: Clock, badgeClass: 'bg-amber-500/10 text-amber-500', subtext: 'Past shift start', tab: 'attendance' },
        { label: 'Absent Today', value: summary.absent, icon: Users, badgeClass: 'bg-rose-500/10 text-rose-500', subtext: 'No punch, no leave', tab: 'attendance' },
        { label: 'Pending Approvals', value: pendingApprovals, icon: ListChecks, badgeClass: 'bg-orange-500/10 text-orange-500', subtext: 'Leaves · punches · expenses', tab: 'leave' },
      ]}
    />
  );
}

function ZonalKpis({ onNavigate }) {
  const { data: employees = [] } = useEmployees();
  const { data: org } = useOrg();
  const { summary } = useAttendanceSummary(todayIso());
  const { data: leaves = [] } = useLeaves();
  const { data: expenses = [] } = useExpenses();

  const pct = summary.total ? Math.round((summary.checkedIn / summary.total) * 100) : 0;
  const pendingApprovals =
    leaves.filter((l) => l.status === 'Pending').length + expenses.filter((e) => e.status === 'Pending').length;

  return (
    <KpiRow
      onNavigate={onNavigate}
      kpis={[
        { label: 'Branches', value: (org?.branches ?? []).length, icon: Building2, badgeClass: 'bg-blue-500/10 text-blue-500', subtext: 'In your zone', tab: 'organization' },
        { label: 'Headcount', value: employees.filter((e) => e.status === 'Active').length, icon: Users, badgeClass: 'bg-[#0ea971]/10 text-[#0ea971]', subtext: 'Active employees', tab: 'directory' },
        { label: 'Attendance Today', value: `${pct}%`, icon: CalendarCheck2, badgeClass: 'bg-emerald-500/10 text-emerald-500', subtext: `${summary.checkedIn}/${summary.total} checked in`, tab: 'attendance' },
        { label: 'Pending Approvals', value: pendingApprovals, icon: ListChecks, badgeClass: 'bg-orange-500/10 text-orange-500', subtext: 'Across all branches', tab: 'leave' },
      ]}
    />
  );
}

function HrKpis({ onNavigate }) {
  const { data: employees = [] } = useEmployees();
  const { summary } = useAttendanceSummary(todayIso());
  const { data: exits = [] } = useExits();
  const { data: tickets = [] } = useTickets();
  const { data: leaves = [] } = useLeaves();

  const start = `${todayIso().slice(0, 7)}-01`;
  const joiners = employees.filter((e) => e.join_date && e.join_date >= start).length;
  const active = employees.filter((e) => e.status === 'Active').length;

  return (
    <KpiRow
      onNavigate={onNavigate}
      kpis={[
        { label: 'Headcount', value: active, icon: Users, badgeClass: 'bg-[#0ea971]/10 text-[#0ea971]', subtext: 'Active in your scope', tab: 'directory' },
        { label: 'Checked In', value: summary.checkedIn, icon: CalendarCheck2, badgeClass: 'bg-emerald-500/10 text-emerald-500', subtext: 'Today', tab: 'attendance' },
        { label: 'Joiners (MTD)', value: joiners, icon: UserPlus, badgeClass: 'bg-blue-500/10 text-blue-500', subtext: 'This month', tab: 'directory' },
        { label: 'Exits Open', value: exits.filter((x) => x.status !== 'Completed' && x.status !== 'Cleared').length, icon: DoorOpen, badgeClass: 'bg-rose-500/10 text-rose-500', subtext: 'In clearance', tab: 'helpdesk' },
        { label: 'Pending Leaves', value: leaves.filter((l) => l.status === 'Pending').length, icon: CalendarDays, badgeClass: 'bg-amber-500/10 text-amber-500', subtext: 'Awaiting decision', tab: 'leave' },
        { label: 'Open Tickets', value: tickets.filter((t) => t.status !== 'Resolved').length, icon: LifeBuoy, badgeClass: 'bg-orange-500/10 text-orange-500', subtext: 'Helpdesk queue', tab: 'helpdesk' },
      ]}
    />
  );
}

function EntityKpis({ onNavigate }) {
  const { data: employees = [] } = useEmployees();
  const { data: org } = useOrg();
  const { summary } = useAttendanceSummary(todayIso());
  const { data: jobs = [] } = useJobs();
  const { data: expenses = [] } = useExpenses();
  const { data: leaves = [] } = useLeaves();

  const start = `${todayIso().slice(0, 7)}-01`;
  const mtdSpend = expenses
    .filter((e) => (e.expense_date || '') >= start && (e.status === 'Approved' || e.status === 'Paid'))
    .reduce((n, e) => n + Number(e.amount || 0), 0);

  return (
    <KpiRow
      onNavigate={onNavigate}
      kpis={[
        { label: 'Headcount', value: employees.filter((e) => e.status === 'Active').length, icon: Users, badgeClass: 'bg-[#0ea971]/10 text-[#0ea971]', subtext: 'Active employees', tab: 'directory' },
        { label: 'Branches', value: (org?.branches ?? []).length, icon: Building2, badgeClass: 'bg-blue-500/10 text-blue-500', subtext: 'Across the entity', tab: 'organization' },
        { label: 'Checked In', value: summary.checkedIn, icon: CalendarCheck2, badgeClass: 'bg-emerald-500/10 text-emerald-500', subtext: 'Today', tab: 'attendance' },
        { label: 'Pending Leaves', value: leaves.filter((l) => l.status === 'Pending').length, icon: CalendarDays, badgeClass: 'bg-amber-500/10 text-amber-500', subtext: 'Awaiting decision', tab: 'leave' },
        { label: 'Open Roles', value: jobs.filter((j) => j.status === 'Open').length, icon: Briefcase, badgeClass: 'bg-violet-500/10 text-violet-500', subtext: 'Recruitment', tab: 'recruitment' },
        { label: 'Spend (MTD)', value: inr(mtdSpend), icon: DollarSign, badgeClass: 'bg-orange-500/10 text-orange-500', subtext: 'Approved expenses', tab: 'expense' },
      ]}
    />
  );
}

function SuperKpis({ onNavigate }) {
  const { data: employees = [] } = useEmployees();
  const { data: org } = useOrg();
  const { summary } = useAttendanceSummary(todayIso());
  const { data: users = [] } = useManagedUsers();
  const { data: tickets = [] } = useTickets();

  return (
    <KpiRow
      onNavigate={onNavigate}
      kpis={[
        { label: 'Entities', value: (org?.entities ?? []).length, icon: Network, badgeClass: 'bg-purple-500/10 text-purple-500', subtext: 'Companies mapped', tab: 'organization' },
        { label: 'Branches', value: (org?.branches ?? []).length, icon: Building2, badgeClass: 'bg-blue-500/10 text-blue-500', subtext: 'All entities', tab: 'organization' },
        { label: 'Employees', value: employees.filter((e) => e.status === 'Active').length, icon: Users, badgeClass: 'bg-[#0ea971]/10 text-[#0ea971]', subtext: 'Active, system-wide', tab: 'directory' },
        { label: 'Checked In', value: summary.checkedIn, icon: CalendarCheck2, badgeClass: 'bg-emerald-500/10 text-emerald-500', subtext: 'Today', tab: 'attendance' },
        { label: 'Logins', value: users.length, icon: Shield, badgeClass: 'bg-violet-500/10 text-violet-500', subtext: 'Provisioned users', tab: 'administration' },
        { label: 'Open Tickets', value: tickets.filter((t) => t.status !== 'Resolved').length, icon: LifeBuoy, badgeClass: 'bg-orange-500/10 text-orange-500', subtext: 'Helpdesk queue', tab: 'helpdesk' },
      ]}
    />
  );
}

function TodayPriorities({ role, onNavigate }) {
  const { employee } = useAuth();
  const { canAny, canBeyondSelf } = usePermissions();
  const { summary } = useAttendanceSummary(todayIso());
  const { data: leaves = [] } = useLeaves();
  const { data: expenses = [] } = useExpenses();
  const { data: regs = [] } = useRegularizations('Pending');
  const { data: tickets = [] } = useTickets();
  const { data: exits = [] } = useExits();
  const { data: jobs = [] } = useJobs();

  const myLeavePending = leaves.filter((l) => l.status === 'Pending' && l.employee?.id === employee?.id).length;
  const myExpensePending = expenses.filter((e) => e.status === 'Pending' && e.employee?.id === employee?.id).length;
  const myTickets = tickets.filter((t) => t.status !== 'Resolved' && t.employee?.id === employee?.id).length;
  const pendingLeaves = canAny('leave.approve') ? leaves.filter((l) => l.status === 'Pending' && l.employee?.id !== employee?.id).length : 0;
  const pendingExpenses = canAny('expense.approve') ? expenses.filter((e) => e.status === 'Pending' && e.employee?.id !== employee?.id).length : 0;
  const pendingPunches = canBeyondSelf('attendance.manage') ? regs.filter((r) => r.employee?.id !== employee?.id).length : 0;
  const openTickets = tickets.filter((t) => t.status !== 'Resolved').length;
  const exitsOpen = exits.filter((x) => x.status !== 'Completed' && x.status !== 'Cleared').length;
  const openRoles = jobs.filter((j) => j.status === 'Open').length;
  const dateLabel = new Date().toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long',
  });
  const roleTitle = ROLE_TITLES[role] || 'Dashboard';

  const items = [
    pendingPunches > 0 && {
      title: `${pendingPunches} punch correction${pendingPunches > 1 ? 's' : ''} waiting`,
      detail: 'Resolve attendance exceptions before payroll cleanup.',
      icon: Clock,
      tone: 'violet',
      tab: 'attendance',
      weight: 10,
    },
    pendingLeaves > 0 && {
      title: `${pendingLeaves} leave request${pendingLeaves > 1 ? 's' : ''} need decision`,
      detail: 'Approve or reject pending leave before coverage is affected.',
      icon: CalendarDays,
      tone: 'amber',
      tab: 'leave',
      weight: 9,
    },
    pendingExpenses > 0 && {
      title: `${pendingExpenses} expense claim${pendingExpenses > 1 ? 's' : ''} pending`,
      detail: 'Review reimbursements and keep finance queues clean.',
      icon: ReceiptText,
      tone: 'orange',
      tab: 'expense',
      weight: 8,
    },
    summary.absent > 0 && canBeyondSelf('attendance.read') && {
      title: `${summary.absent} absent today`,
      detail: 'Check coverage and confirm whether leave or correction is needed.',
      icon: AlertTriangle,
      tone: 'red',
      tab: 'attendance',
      weight: 7,
    },
    summary.missingPunch > 0 && canBeyondSelf('attendance.read') && {
      title: `${summary.missingPunch} missing punch${summary.missingPunch > 1 ? 'es' : ''}`,
      detail: 'Clean up incomplete attendance records early.',
      icon: Clock,
      tone: 'violet',
      tab: 'attendance',
      weight: 6,
    },
    openTickets > 0 && role !== 'employee' && {
      title: `${openTickets} open helpdesk ticket${openTickets > 1 ? 's' : ''}`,
      detail: 'Keep employee support items moving.',
      icon: LifeBuoy,
      tone: 'blue',
      tab: 'helpdesk',
      weight: 5,
    },
    exitsOpen > 0 && ['hr_manager', 'entity_admin'].includes(role) && {
      title: `${exitsOpen} exit clearance${exitsOpen > 1 ? 's' : ''} open`,
      detail: 'Track pending separation tasks and handovers.',
      icon: DoorOpen,
      tone: 'red',
      tab: 'helpdesk',
      weight: 4,
    },
    openRoles > 0 && ['hr_manager', 'entity_admin', 'super_admin'].includes(role) && {
      title: `${openRoles} open role${openRoles > 1 ? 's' : ''} in hiring`,
      detail: 'Review active recruitment demand.',
      icon: Briefcase,
      tone: 'blue',
      tab: 'recruitment',
      weight: 3,
    },
    role === 'employee' && myLeavePending > 0 && {
      title: `${myLeavePending} leave request${myLeavePending > 1 ? 's' : ''} awaiting approval`,
      detail: 'Track the latest status from your leave page.',
      icon: CalendarDays,
      tone: 'amber',
      tab: 'leave',
      weight: 8,
    },
    role === 'employee' && myExpensePending > 0 && {
      title: `${myExpensePending} expense claim${myExpensePending > 1 ? 's' : ''} awaiting approval`,
      detail: 'Follow reimbursement progress from expenses.',
      icon: ReceiptText,
      tone: 'orange',
      tab: 'expense',
      weight: 7,
    },
    role === 'employee' && myTickets > 0 && {
      title: `${myTickets} support ticket${myTickets > 1 ? 's' : ''} open`,
      detail: 'Check replies or update your request.',
      icon: LifeBuoy,
      tone: 'blue',
      tab: 'helpdesk',
      weight: 6,
    },
  ]
    .filter(Boolean)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 4);

  if (items.length === 0) {
    return (
      <section className="premium-card dashboard-priority-center is-clear">
        <div className="dashboard-priority-copy">
          <span className="dashboard-priority-icon is-green"><CheckCircle2 size={16} /></span>
          <div>
            <div className="dashboard-priority-meta">
              <span>{roleTitle}</span>
              <span>{dateLabel}</span>
            </div>
            <h2>Today’s priorities are clear</h2>
            <p>No urgent dashboard items in your current scope.</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="premium-card dashboard-priority-center">
      <div className="dashboard-priority-copy">
        <span className="dashboard-priority-icon"><AlertTriangle size={16} /></span>
        <div>
          <div className="dashboard-priority-meta">
            <span>{roleTitle}</span>
            <span>{dateLabel}</span>
          </div>
          <h2>Today’s Priorities</h2>
          <p>Resolve the few items most likely to affect attendance, approvals, or employee support.</p>
        </div>
      </div>
      <div className="dashboard-priority-list">
        {items.map(({ title, detail, icon: Icon, tone, tab }) => (
          <button key={title} type="button" data-tone={tone} onClick={() => onNavigate?.(tab)}>
            <span className="dashboard-priority-item-icon"><Icon size={14} /></span>
            <span className="dashboard-priority-item-text">
              <strong>{title}</strong>
              <span>{detail}</span>
            </span>
            <ArrowRight size={13} />
          </button>
        ))}
      </div>
    </section>
  );
}

/* ---------------------------------- role presets ---------------------------------- */

function EmployeeDashboard({ onNavigate, actions }) {
  return (
    <>
      <EssKpis onNavigate={onNavigate} />
      <TodayPriorities role="employee" onNavigate={onNavigate} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <PunchCard onNavigate={onNavigate} />
        <MyMonthCard onNavigate={onNavigate} />
        <MyLeaveBalances onNavigate={onNavigate} />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <MyRequests onNavigate={onNavigate} />
        <MyTasks onNavigate={onNavigate} />
        <div className="space-y-4">
          <MyPayslip onNavigate={onNavigate} />
          <HolidaysCard showAnniversaries={false} onNavigate={onNavigate} />
        </div>
      </div>
      <QuickActions actions={actions} onNavigate={onNavigate} />
    </>
  );
}

function BranchManagerDashboard({ onNavigate, actions }) {
  return (
    <>
      <TeamKpis onNavigate={onNavigate} />
      <TodayPriorities role="branch_manager" onNavigate={onNavigate} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="space-y-4 xl:col-span-8">
          <TeamAttendanceToday onNavigate={onNavigate} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <OnLeaveThisWeek onNavigate={onNavigate} />
            <TeamTickets onNavigate={onNavigate} />
          </div>
          <QuickActions actions={actions} onNavigate={onNavigate} />
        </div>
        <aside className="space-y-4 xl:col-span-4">
          <ApprovalsQueue onNavigate={onNavigate} />
          <TeamAssets onNavigate={onNavigate} />
          <HolidaysCard showAnniversaries onNavigate={onNavigate} />
        </aside>
      </div>
      <EssSection onNavigate={onNavigate} />
    </>
  );
}

function DeptHeadDashboard({ onNavigate, actions }) {
  return (
    <>
      <TeamKpis onNavigate={onNavigate} />
      <TodayPriorities role="dept_head" onNavigate={onNavigate} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="space-y-4 xl:col-span-8">
          <TeamAttendanceToday onNavigate={onNavigate} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <TeamTasksBoard onNavigate={onNavigate} />
            <OnLeaveThisWeek onNavigate={onNavigate} />
          </div>
          <QuickActions actions={actions} onNavigate={onNavigate} />
        </div>
        <aside className="space-y-4 xl:col-span-4">
          <ApprovalsQueue onNavigate={onNavigate} />
          <HolidaysCard showAnniversaries onNavigate={onNavigate} />
        </aside>
      </div>
      <EssSection onNavigate={onNavigate} />
    </>
  );
}

function ZonalManagerDashboard({ onNavigate, actions }) {
  return (
    <>
      <ZonalKpis onNavigate={onNavigate} />
      <TodayPriorities role="zonal_manager" onNavigate={onNavigate} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="space-y-4 xl:col-span-8">
          <BranchComparison onNavigate={onNavigate} />
          <AttendanceHealthCard onNavigate={onNavigate} />
          <QuickActions actions={actions} onNavigate={onNavigate} />
        </div>
        <aside className="space-y-4 xl:col-span-4">
          <ApprovalsQueue onNavigate={onNavigate} />
          <TeamTickets onNavigate={onNavigate} />
          <HolidaysCard showAnniversaries onNavigate={onNavigate} />
        </aside>
      </div>
      <EssSection onNavigate={onNavigate} />
    </>
  );
}

function HrManagerDashboard({ onNavigate, actions }) {
  return (
    <>
      <HrKpis onNavigate={onNavigate} />
      <TodayPriorities role="hr_manager" onNavigate={onNavigate} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="space-y-4 xl:col-span-8">
          <TeamAttendanceToday onNavigate={onNavigate} />
          <AttendanceHealthCard onNavigate={onNavigate} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <OnboardingPipeline onNavigate={onNavigate} />
            <ExitPipeline onNavigate={onNavigate} />
          </div>
          <HeadcountChart groupBy="branch" onNavigate={onNavigate} />
          <QuickActions actions={actions} onNavigate={onNavigate} />
        </div>
        <aside className="space-y-4 xl:col-span-4">
          <ApprovalsQueue onNavigate={onNavigate} />
          <TeamTickets onNavigate={onNavigate} />
          <DocumentsSnapshot onNavigate={onNavigate} />
          <HolidaysCard showAnniversaries onNavigate={onNavigate} />
        </aside>
      </div>
      <EssSection onNavigate={onNavigate} />
    </>
  );
}

function EntityAdminDashboard({ onNavigate, actions }) {
  return (
    <>
      <EntityKpis onNavigate={onNavigate} />
      <TodayPriorities role="entity_admin" onNavigate={onNavigate} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="space-y-4 xl:col-span-8">
          <BranchComparison onNavigate={onNavigate} />
          <AttendanceHealthCard onNavigate={onNavigate} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <OnboardingPipeline onNavigate={onNavigate} />
            <ExitPipeline onNavigate={onNavigate} />
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <RecruitmentOverview onNavigate={onNavigate} />
            <ExpenseSpend onNavigate={onNavigate} />
          </div>
          <HeadcountChart groupBy="branch" onNavigate={onNavigate} />
          <QuickActions actions={actions} onNavigate={onNavigate} />
        </div>
        <aside className="space-y-4 xl:col-span-4">
          <ApprovalsQueue onNavigate={onNavigate} />
          <UserAccessPanel onNavigate={onNavigate} />
          <DeviceHealth onNavigate={onNavigate} />
          <AuditFeed onNavigate={onNavigate} />
          <HolidaysCard showAnniversaries onNavigate={onNavigate} />
        </aside>
      </div>
      <EssSection onNavigate={onNavigate} />
    </>
  );
}

function SuperAdminDashboard({ onNavigate, actions }) {
  return (
    <>
      <SuperKpis onNavigate={onNavigate} />
      <TodayPriorities role="super_admin" onNavigate={onNavigate} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="space-y-4 xl:col-span-8">
          <EntityComparison onNavigate={onNavigate} />
          <BranchComparison onNavigate={onNavigate} />
          <AttendanceHealthCard onNavigate={onNavigate} />
          <HeadcountChart groupBy="entity" onNavigate={onNavigate} />
          <QuickActions actions={actions} onNavigate={onNavigate} />
        </div>
        <aside className="space-y-4 xl:col-span-4">
          <UserAccessPanel onNavigate={onNavigate} />
          <DeviceHealth onNavigate={onNavigate} />
          <ApprovalsQueue onNavigate={onNavigate} />
          <AuditFeed onNavigate={onNavigate} />
          <HolidaysCard showAnniversaries onNavigate={onNavigate} />
        </aside>
      </div>
      <EssSection onNavigate={onNavigate} />
    </>
  );
}

const PRESETS = {
  super_admin: SuperAdminDashboard,
  entity_admin: EntityAdminDashboard,
  hr_manager: HrManagerDashboard,
  zonal_manager: ZonalManagerDashboard,
  branch_manager: BranchManagerDashboard,
  dept_head: DeptHeadDashboard,
  employee: EmployeeDashboard,
};

// Quick actions per role, still permission-filtered so a trimmed custom role never sees a dead link.
function useQuickActions(role) {
  const { canAny, canBeyondSelf } = usePermissions();
  const all = {
    reviewLeaves: canAny('leave.approve') && { label: 'Review Leaves', tab: 'leave', icon: CalendarDays },
    reviewExpenses: canAny('expense.approve') && { label: 'Review Expenses', tab: 'expense', icon: ReceiptText },
    directory: canBeyondSelf('employee.read') && { label: 'Employee Directory', tab: 'directory', icon: Users },
    org: canAny('org.manage') && { label: 'Org Hierarchy', tab: 'organization', icon: Network },
    applyLeave: canAny('leave.create') && { label: 'Apply for Leave', tab: 'leave', icon: CalendarDays },
    submitExpense: canAny('expense.create') && { label: 'Submit Expense', tab: 'expense', icon: ReceiptText },
    raiseTicket: canAny('ticket.create') && { label: 'Raise a Ticket', tab: 'helpdesk', icon: LifeBuoy },
    tasks: canAny('task.read') && { label: 'Tasks', tab: 'tasks', icon: ListChecks },
    attendance: canAny('attendance.read') && { label: 'Attendance Logs', tab: 'attendance', icon: Clock },
    payroll: canAny('payslip.read') && { label: 'Payroll', tab: 'payroll', icon: DollarSign },
    reports: canAny('report.read') && { label: 'Reports & Analytics', tab: 'reports', icon: BarChart3 },
    performance: canAny('performance.manage') && { label: 'PMS Performance', tab: 'performance', icon: Target },
    recruitment: canAny('recruitment.manage') && { label: 'Recruit Hub', tab: 'recruitment', icon: Briefcase },
    onboarding: canAny('onboarding.manage') && { label: 'Onboarding Board', tab: 'onboarding', icon: UserCheck },
    admin: canAny('rbac.manage') && { label: 'Administration', tab: 'administration', icon: Shield },
    devices: canAny('device.manage') && { label: 'Attendance Setup', tab: 'attendance-admin', icon: Fingerprint },
  };

  const order = {
    employee: ['applyLeave', 'submitExpense', 'raiseTicket', 'tasks', 'attendance', 'payroll'],
    dept_head: ['reviewLeaves', 'tasks', 'performance', 'attendance', 'directory', 'raiseTicket'],
    branch_manager: ['reviewLeaves', 'reviewExpenses', 'attendance', 'tasks', 'directory', 'raiseTicket'],
    zonal_manager: ['reviewLeaves', 'reviewExpenses', 'reports', 'attendance', 'directory', 'tasks'],
    hr_manager: ['directory', 'reviewLeaves', 'attendance', 'onboarding', 'reports', 'devices'],
    entity_admin: ['admin', 'directory', 'org', 'recruitment', 'reports', 'devices'],
    super_admin: ['admin', 'org', 'directory', 'devices', 'reports', 'reviewLeaves'],
  };

  return (order[role] || order.employee).map((k) => all[k]).filter(Boolean);
}

export default function Dashboard({ onNavigate }) {
  const { assignments, isSuperAdmin } = useAuth();
  const role = resolvePrimaryRole(assignments, isSuperAdmin);
  const actions = useQuickActions(role);
  const Preset = PRESETS[role];

  return (
    <div className="page-shell dashboard-shell space-y-5 animate-slide-up py-3">
      <NotificationsStrip onNavigate={onNavigate} />
      <Preset onNavigate={onNavigate} actions={actions} />
    </div>
  );
}
