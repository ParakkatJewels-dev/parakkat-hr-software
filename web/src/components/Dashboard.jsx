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
  Fingerprint, DollarSign, CalendarCheck2, Boxes, FolderOpen,
} from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { usePermissions } from '../auth/usePermissions';
import { resolvePrimaryRole } from '../lib/roles';
import { useEmployees } from '../data/employees';
import { useLeaves } from '../data/leaves';
import { useExpenses } from '../data/expenses';
import { useTickets } from '../data/tickets';
import { useVisibleOrg } from '../data/org';
import { useJobs } from '../data/recruitment';
import { useExits } from '../data/exits';
import { useRegularizations } from '../data/regularizations';
import { useManagedUsers } from '../data/admin';
import { useAttendanceSummary, useMonthlyAttendance, todayIso } from '../data/attendance';
import { useLeaveBalances } from '../data/leaveTypes';
import { KpiRow, HolidaysCard, QuickActions, inr } from './dashboard/shared';
import { useActionableApprovals } from './dashboard/useActionableApprovals';
import ActionCenter from './dashboard/ActionCenter';
import {
  EmployeeTodayHero, PunchCard, MyMonthCard, MyLeaveBalances, MyRequests, MyTasks, MyPayslip, MyRoutineToday, EssSection,
} from './dashboard/selfWidgets';
import {
  TeamAttendanceToday, ApprovalsQueue, OnLeaveThisWeek, TeamTickets, TeamAssets, TeamTasksBoard,
} from './dashboard/teamWidgets';
import {
  AttendanceHealthCard, OnboardingPipeline, ExitPipeline, RecruitmentOverview,
  ExpenseSpend, DocumentsSnapshot, DeviceHealth, UserAccessPanel, AuditFeed, BranchComparison,
  EntityComparison, CrossDeptRequests,
} from './dashboard/orgWidgets';

// recharts is the single heaviest dependency; only three presets show a chart, so it is fetched
// after paint rather than shipped to every employee.
const LazyHeadcountChart = lazy(() => import('./dashboard/HeadcountChart'));
const HeadcountChart = (props) => (
  <Suspense fallback={<div className="premium-card h-64 animate-pulse" />}>
    <LazyHeadcountChart {...props} />
  </Suspense>
);

/* ---------------------------------- per-role KPI rows ---------------------------------- */
// Each KPI row is its own component so its queries only run for the preset that shows it.

const validSeries = (values) => values.map((v) => Number(v) || 0).filter((v) => Number.isFinite(v));

const countsBy = (items, keyFn) => {
  const map = new Map();
  for (const item of items ?? []) {
    const key = keyFn(item) || 'Unassigned';
    map.set(key, (map.get(key) || 0) + 1);
  }
  return validSeries([...map.values()]);
};

const employeeStatusSeries = (employees) =>
  ['Active', 'Probation', 'On Leave', 'Inactive'].map((status) => employees.filter((e) => e.status === status).length);

const attendanceSummarySeries = (summary) =>
  [summary.checkedIn, summary.stillIn, summary.late, summary.absent, summary.onLeave, summary.missingPunch];

const attendanceDaySeries = (rows, predicate) =>
  rows
    .slice()
    .sort((a, b) => (a.work_date || '').localeCompare(b.work_date || ''))
    .map((row) => (predicate(row) ? 1 : 0))
    .slice(-10);

const datedCountSeries = (rows, dateField, predicate = () => true) => {
  const map = new Map();
  for (const row of rows ?? []) {
    if (!predicate(row)) continue;
    const key = (row[dateField] || row.created_at || '').slice(0, 10);
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, count]) => count).slice(-10);
};

const queueSeries = (...counts) => validSeries(counts);

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
  // MY pending requests. Every sibling KPI on this row already filters by employee?.id; this one did
  // not, so on the employee dashboard it showed the whole company's approval backlog under the
  // heading "Awaiting approval" — for an HR manager working as an employee, a number in the dozens
  // where the true answer was nought or one.
  const myLeaves = leaves.filter((l) => l.employee_id === employee?.id);
  const myExpenses = expenses.filter((e) => e.employee_id === employee?.id);
  const pending = myLeaves.filter((l) => l.status === 'Pending').length
    + myExpenses.filter((e) => e.status === 'Pending').length;

  return (
    <KpiRow
      onNavigate={onNavigate}
      kpis={[
        { label: 'Days Present', value: present, icon: CalendarCheck2, badgeClass: 'bg-brand/10 text-brand-ink', subtext: 'This month', tab: 'attendance', trend: attendanceDaySeries(monthRows, (r) => r.status === 'Present' || r.status === 'Half Day') },
        { label: 'Late Marks', value: late, icon: Clock, badgeClass: 'bg-amber-500/10 text-amber-500', subtext: 'This month', tab: 'attendance', trend: attendanceDaySeries(monthRows, (r) => r.is_late) },
        { label: 'Leave Available', value: available, icon: CalendarDays, badgeClass: 'bg-brand-soft text-brand-ink', subtext: 'Across all types', tab: 'leave', trend: balances.map((b) => Number(b.available || 0)) },
        { label: 'Pending Requests', value: pending, icon: ListChecks, badgeClass: 'bg-orange-500/10 text-orange-500', subtext: 'Awaiting approval', tab: 'leave', trend: queueSeries(myLeaves.filter((l) => l.status === 'Pending').length, myExpenses.filter((e) => e.status === 'Pending').length) },
      ]}
    />
  );
}

export function TeamKpis({ onNavigate }) {
  const { data: employees = [] } = useEmployees();
  const { data: attendanceRows = [], summary } = useAttendanceSummary(todayIso());
  const { data: leaves = [] } = useLeaves();
  const { data: expenses = [] } = useExpenses();
  const { data: regs = [] } = useRegularizations('Pending');

  const approvals = useActionableApprovals({ leaves, expenses, regs });

  return (
    <KpiRow
      onNavigate={onNavigate}
      kpis={[
        { label: 'Team Size', value: employees.filter((e) => e.status === 'Active').length, icon: Users, badgeClass: 'bg-brand/10 text-brand-ink', subtext: 'Active', tab: 'directory', trend: employeeStatusSeries(employees) },
        { label: 'Checked In', value: summary.checkedIn, icon: CalendarCheck2, badgeClass: 'bg-emerald-500/10 text-emerald-500', subtext: 'Today', tab: 'attendance', trend: attendanceSummarySeries(summary) },
        { label: 'Late Today', value: summary.late, icon: Clock, badgeClass: 'bg-amber-500/10 text-amber-500', subtext: 'Past shift start', tab: 'attendance', trend: countsBy(attendanceRows.filter((r) => r.is_late), (r) => r.employee?.branch?.code || r.employee?.department?.name) },
        { label: 'Absent Today', value: summary.absent, icon: Users, badgeClass: 'bg-rose-500/10 text-rose-500', subtext: 'No punch, no leave', tab: 'attendance', trend: countsBy(attendanceRows.filter((r) => r.status === 'Absent'), (r) => r.employee?.branch?.code || r.employee?.department?.name) },
        { label: 'Pending Approvals', value: approvals.total, icon: ListChecks, badgeClass: 'bg-orange-500/10 text-orange-500', subtext: 'Ready for your decision', tab: 'leave', trend: queueSeries(approvals.leaves.length, approvals.expenses.length, approvals.punches.length) },
      ]}
    />
  );
}

export function ZonalKpis({ onNavigate }) {
  const { data: employees = [] } = useEmployees();
  const { data: org } = useVisibleOrg();
  const { summary } = useAttendanceSummary(todayIso());
  const { data: leaves = [] } = useLeaves();
  const { data: expenses = [] } = useExpenses();
  const { data: regs = [] } = useRegularizations('Pending');

  const pct = summary.total ? Math.round((summary.checkedIn / summary.total) * 100) : 0;
  const approvals = useActionableApprovals({ leaves, expenses, regs });

  return (
    <KpiRow
      onNavigate={onNavigate}
      kpis={[
        { label: 'Branches', value: (org?.branches ?? []).length, icon: Building2, badgeClass: 'bg-brand-soft text-brand-ink', subtext: 'In your zone', tab: 'organization', trend: countsBy(employees, (e) => e.branch?.code || e.branch?.name) },
        { label: 'Headcount', value: employees.filter((e) => e.status === 'Active').length, icon: Users, badgeClass: 'bg-brand/10 text-brand-ink', subtext: 'Active employees', tab: 'directory', trend: employeeStatusSeries(employees) },
        { label: 'Attendance Today', value: `${pct}%`, icon: CalendarCheck2, badgeClass: 'bg-emerald-500/10 text-emerald-500', subtext: `${summary.checkedIn}/${summary.total} checked in`, tab: 'attendance', trend: attendanceSummarySeries(summary) },
        { label: 'Pending Approvals', value: approvals.total, icon: ListChecks, badgeClass: 'bg-orange-500/10 text-orange-500', subtext: 'Ready for your decision', tab: 'leave', trend: queueSeries(approvals.leaves.length, approvals.expenses.length, approvals.punches.length) },
      ]}
    />
  );
}

export function HrKpis({ onNavigate }) {
  const { data: employees = [] } = useEmployees();
  const { summary } = useAttendanceSummary(todayIso());
  const { data: exits = [] } = useExits();
  const { data: tickets = [] } = useTickets();
  const { data: leaves = [] } = useLeaves();
  const approvals = useActionableApprovals({ leaves });

  const today = todayIso();
  const start = `${today.slice(0, 7)}-01`;
  const joinedMtd = (e) => e.join_date && e.join_date >= start && e.join_date <= today;
  const joiners = employees.filter(joinedMtd).length;
  const active = employees.filter((e) => e.status === 'Active').length;

  return (
    <KpiRow
      onNavigate={onNavigate}
      kpis={[
        { label: 'Headcount', value: active, icon: Users, badgeClass: 'bg-brand/10 text-brand-ink', subtext: 'Active', tab: 'directory', trend: countsBy(employees.filter((e) => e.status === 'Active'), (e) => e.branch?.code || e.department?.name) },
        { label: 'Checked In', value: summary.checkedIn, icon: CalendarCheck2, badgeClass: 'bg-emerald-500/10 text-emerald-500', subtext: 'Today', tab: 'attendance', trend: attendanceSummarySeries(summary) },
        { label: 'Joiners (MTD)', value: joiners, icon: UserPlus, badgeClass: 'bg-brand-soft text-brand-ink', subtext: 'This month', tab: 'directory', trend: datedCountSeries(employees, 'join_date', joinedMtd) },
        { label: 'Exits Open', value: exits.filter((x) => x.status !== 'Completed' && x.status !== 'Cleared').length, icon: DoorOpen, badgeClass: 'bg-rose-500/10 text-rose-500', subtext: 'In clearance', tab: 'helpdesk', trend: countsBy(exits.filter((x) => x.status !== 'Completed' && x.status !== 'Cleared'), (x) => x.status) },
        { label: 'Pending Leaves', value: approvals.leaves.length, icon: CalendarDays, badgeClass: 'bg-amber-500/10 text-amber-500', subtext: 'Ready for your decision', tab: 'leave', trend: datedCountSeries(approvals.leaves, 'created_at') },
        { label: 'Open Tickets', value: tickets.filter((t) => t.status !== 'Resolved').length, icon: LifeBuoy, badgeClass: 'bg-orange-500/10 text-orange-500', subtext: 'Helpdesk', tab: 'helpdesk', trend: countsBy(tickets.filter((t) => t.status !== 'Resolved'), (t) => t.status) },
      ]}
    />
  );
}

export function EntityKpis({ onNavigate }) {
  const { data: employees = [] } = useEmployees();
  const { data: org } = useVisibleOrg();
  const { summary } = useAttendanceSummary(todayIso());
  const { data: jobs = [] } = useJobs();
  const { data: expenses = [] } = useExpenses();
  const { data: leaves = [] } = useLeaves();
  const approvals = useActionableApprovals({ leaves });

  const start = `${todayIso().slice(0, 7)}-01`;
  const mtdSpend = expenses
    .filter((e) => (e.expense_date || '') >= start && (e.status === 'Approved' || e.status === 'Paid'))
    .reduce((n, e) => n + Number(e.amount || 0), 0);

  return (
    <KpiRow
      onNavigate={onNavigate}
      kpis={[
        { label: 'Headcount', value: employees.filter((e) => e.status === 'Active').length, icon: Users, badgeClass: 'bg-brand/10 text-brand-ink', subtext: 'Active employees', tab: 'directory', trend: countsBy(employees.filter((e) => e.status === 'Active'), (e) => e.branch?.code || e.department?.name) },
        { label: 'Branches', value: (org?.branches ?? []).length, icon: Building2, badgeClass: 'bg-brand-soft text-brand-ink', subtext: 'Across the entity', tab: 'organization', trend: countsBy(employees, (e) => e.branch?.code || e.branch?.name) },
        { label: 'Checked In', value: summary.checkedIn, icon: CalendarCheck2, badgeClass: 'bg-emerald-500/10 text-emerald-500', subtext: 'Today', tab: 'attendance', trend: attendanceSummarySeries(summary) },
        { label: 'Pending Leaves', value: approvals.leaves.length, icon: CalendarDays, badgeClass: 'bg-amber-500/10 text-amber-500', subtext: 'Ready for your decision', tab: 'leave', trend: datedCountSeries(approvals.leaves, 'created_at') },
        { label: 'Open Roles', value: jobs.filter((j) => j.status === 'Open').length, icon: Briefcase, badgeClass: 'bg-brand-soft text-brand-ink', subtext: 'Recruitment', tab: 'recruitment', trend: countsBy(jobs.filter((j) => j.status === 'Open'), (j) => j.department || j.location || j.title) },
        { label: 'Spend (MTD)', value: inr(mtdSpend), icon: DollarSign, badgeClass: 'bg-orange-500/10 text-orange-500', subtext: 'Approved expenses', tab: 'expense', trend: datedCountSeries(expenses, 'expense_date', (e) => (e.expense_date || '') >= start && (e.status === 'Approved' || e.status === 'Paid')) },
      ]}
    />
  );
}

function SuperKpis({ onNavigate }) {
  const { data: employees = [] } = useEmployees();
  const { data: org } = useVisibleOrg();
  const { summary } = useAttendanceSummary(todayIso());
  const { data: users = [] } = useManagedUsers();
  const { data: tickets = [] } = useTickets();

  return (
    <KpiRow
      onNavigate={onNavigate}
      kpis={[
        { label: 'Entities', value: (org?.entities ?? []).length, icon: Network, badgeClass: 'bg-purple-500/10 text-purple-500', subtext: 'Companies', tab: 'organization', trend: countsBy(employees, (e) => e.entity?.code || e.entity?.name) },
        { label: 'Branches', value: (org?.branches ?? []).length, icon: Building2, badgeClass: 'bg-brand-soft text-brand-ink', subtext: 'All entities', tab: 'organization', trend: countsBy(employees, (e) => e.branch?.code || e.branch?.name) },
        { label: 'Employees', value: employees.filter((e) => e.status === 'Active').length, icon: Users, badgeClass: 'bg-brand/10 text-brand-ink', subtext: 'Active', tab: 'directory', trend: employeeStatusSeries(employees) },
        { label: 'Checked In', value: summary.checkedIn, icon: CalendarCheck2, badgeClass: 'bg-emerald-500/10 text-emerald-500', subtext: 'Today', tab: 'attendance', trend: attendanceSummarySeries(summary) },
        { label: 'Logins', value: users.length, icon: Shield, badgeClass: 'bg-brand-soft text-brand-ink', subtext: 'users', tab: 'administration', trend: countsBy(users, (u) => u.roles?.[0]?.role_key || (u.is_super_admin ? 'super_admin' : 'no_role')) },
        { label: 'Open Tickets', value: tickets.filter((t) => t.status !== 'Resolved').length, icon: LifeBuoy, badgeClass: 'bg-orange-500/10 text-orange-500', subtext: 'Helpdesk', tab: 'helpdesk', trend: countsBy(tickets.filter((t) => t.status !== 'Resolved'), (t) => t.status || t.category) },
      ]}
    />
  );
}

/* ---------------------------------- role presets ---------------------------------- */

function EmployeeDashboard({ onNavigate, actions }) {
  return (
    <>
      <EmployeeTodayHero onNavigate={onNavigate} />
      <MyRoutineToday onNavigate={onNavigate} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <MyTasks onNavigate={onNavigate} />
        <MyRequests onNavigate={onNavigate} />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <PunchCard onNavigate={onNavigate} />
        <MyLeaveBalances onNavigate={onNavigate} />
        <MyPayslip onNavigate={onNavigate} />
      </div>
      <MyMonthCard onNavigate={onNavigate} />
      <QuickActions actions={actions} onNavigate={onNavigate} />
      <HolidaysCard showAnniversaries={false} onNavigate={onNavigate} />
    </>
  );
}

function BranchManagerDashboard({ onNavigate, actions }) {
  return (
    <>
      <TeamKpis onNavigate={onNavigate} />
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
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="space-y-4 xl:col-span-8">
          <TeamAttendanceToday onNavigate={onNavigate} />
          <AttendanceHealthCard onNavigate={onNavigate} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <OnboardingPipeline onNavigate={onNavigate} />
            <ExitPipeline onNavigate={onNavigate} />
          </div>
          <CrossDeptRequests onNavigate={onNavigate} />
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
          {/* Who is leaning on whom. Only an administrator sees this — a head's own two ends are
              already on their Requests tab, and help_requests_select gives them nothing wider. */}
          <CrossDeptRequests onNavigate={onNavigate} />
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
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="space-y-4 xl:col-span-8">
          <EntityComparison onNavigate={onNavigate} />
          <BranchComparison onNavigate={onNavigate} />
          <AttendanceHealthCard onNavigate={onNavigate} />
          <CrossDeptRequests onNavigate={onNavigate} />
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
    raiseTicket: canAny('ticket.create') && { label: 'Help Request', tab: 'helpdesk', icon: LifeBuoy },
    tasks: canAny('task.read') && { label: 'My Tasks', tab: 'tasks', icon: ListChecks },
    attendance: canAny('attendance.read') && { label: 'My Attendance', tab: 'attendance', icon: Clock },
    payroll: canAny('payslip.read') && { label: 'My Payslips', tab: 'payroll', icon: DollarSign },
    myAssets: canAny('asset.read') && { label: 'My Assets', tab: 'my-assets', icon: Boxes },
    documents: canAny('document.read') && { label: 'My Documents', tab: 'documents', icon: FolderOpen },
    reports: canAny('report.read') && { label: 'Reports & Analytics', tab: 'reports', icon: BarChart3 },
    performance: canAny('performance.manage') && { label: 'PMS Performance', tab: 'performance', icon: Target },
    recruitment: canAny('recruitment.manage') && { label: 'Recruit Hub', tab: 'recruitment', icon: Briefcase },
    onboarding: canAny('onboarding.manage') && { label: 'Onboarding Board', tab: 'onboarding', icon: UserCheck },
    admin: canAny('rbac.manage') && { label: 'Administration', tab: 'administration', icon: Shield },
    devices: canAny('device.manage') && { label: 'Attendance Setup', tab: 'attendance-admin', icon: Fingerprint },
  };

  const order = {
    employee: ['attendance', 'applyLeave', 'payroll', 'tasks', 'submitExpense', 'myAssets', 'documents', 'raiseTicket'],
    dept_head: ['reviewLeaves', 'tasks', 'performance', 'attendance', 'directory', 'raiseTicket'],
    branch_manager: ['reviewLeaves', 'reviewExpenses', 'attendance', 'tasks', 'directory', 'raiseTicket'],
    zonal_manager: ['reviewLeaves', 'reviewExpenses', 'reports', 'attendance', 'directory', 'tasks'],
    hr_manager: ['directory', 'reviewLeaves', 'attendance', 'onboarding', 'reports', 'devices'],
    entity_admin: ['admin', 'directory', 'org', 'recruitment', 'reports', 'devices'],
    super_admin: ['admin', 'org', 'directory', 'devices', 'reports', 'reviewLeaves'],
  };

  return (order[role] || order.employee).map((k) => all[k]).filter(Boolean);
}

export default function Dashboard({ onNavigate, viewRole }) {
  const { assignments, isSuperAdmin } = useAuth();
  // `viewRole` is the role the person chose to work as (Settings -> Switch view). It falls back to
  // their most senior one, which is what this always used. Every widget still gates on real
  // permissions, so this picks the LAYOUT and never widens what a preset can show.
  const role = viewRole ?? resolvePrimaryRole(assignments, isSuperAdmin);
  const actions = useQuickActions(role);
  const Preset = PRESETS[role];

  return (
    <div className="page-shell dashboard-shell space-y-5 animate-slide-up py-3" data-dashboard-role={role}>
      <ActionCenter onNavigate={onNavigate} />
      {role !== 'employee' && <MyRoutineToday onNavigate={onNavigate} />}
      <Preset onNavigate={onNavigate} actions={actions} />
    </div>
  );
}
