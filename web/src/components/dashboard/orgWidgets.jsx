// Org-level widgets for HR managers, entity admins and super admins. Everything is RLS-scoped:
// an HR manager granted at branch scope sees that branch; an entity admin, their entity; a super
// admin, everything.
import React from 'react';
import {
  Activity, UserPlus, DoorOpen, Briefcase, ReceiptText, FolderOpen,
  Fingerprint, ShieldCheck, ScrollText, Building2, Network,
} from 'lucide-react';
import { useEmployees } from '../../data/employees';
import { usePermissions } from '../../auth/usePermissions';
import { useDayAttendance, todayIso } from '../../data/attendance';
import { useLeaves } from '../../data/leaves';
import { useRegularizations } from '../../data/regularizations';
import { useOnboarding } from '../../data/onboarding';
import { useExits } from '../../data/exits';
import { useJobs, useCandidates } from '../../data/recruitment';
import { useExpenses } from '../../data/expenses';
import { useDocuments } from '../../data/documents';
import { useDevices } from '../../data/devices';
import { useSyncState, useSyncRuns, relativeTime } from '../../data/syncStatus';
import { useManagedUsers } from '../../data/admin';
import { useAuditLog } from '../../data/audit';
import { useAttendanceExceptionSummary } from '../../data/reports';
import { Widget, EmptyNote, StatPill, StatusBadge, fmtDay, inr, relTime } from './shared';

const monthStart = () => `${todayIso().slice(0, 7)}-01`;

/**
 * Attendance health + payroll readiness in one card: everything month-to-date that will block a
 * clean payroll run — missing punches, unresolved corrections, undecided leaves.
 */
export function AttendanceHealthCard({ onNavigate }) {
  const { canBeyondSelf } = usePermissions();
  // Counters come back as a single aggregated row; pulling the rows themselves was 1-2 MB.
  const { data: ex = {} } = useAttendanceExceptionSummary(monthStart(), todayIso());
  const { data: pendingRegs = [] } = useRegularizations('Pending');
  const { data: leaves = [] } = useLeaves();
  // Regularizations are invisible without attendance.manage (a zonal manager holds none), so a
  // "Ready for payroll" verdict from that role would be based on data it cannot see.
  const canJudgeReadiness = canBeyondSelf('attendance.manage');

  const missing = Number(ex.missing_punches || 0);
  const late = Number(ex.late_marks || 0);
  const absent = Number(ex.absences || 0);
  const noShift = Number(ex.no_shift || 0);
  const pendingLeaves = leaves.filter((l) => l.status === 'Pending').length;
  const blockers = missing + pendingRegs.length + pendingLeaves + noShift;

  return (
    <Widget title="Attendance Health · Payroll Readiness" icon={Activity} action="Reports" onAction={() => onNavigate?.('reports')}>
      <div className="mb-3 flex items-center justify-between rounded-xl border px-3 py-2.5 border-neutral-200/70 dark:border-neutral-850">
        <span className="text-base font-bold text-neutral-700 dark:text-warm-gray-200">
          Current cycle ({fmtDay(monthStart())} – today)
        </span>
        <span
          className={`text-2xs font-mono font-bold px-2 py-1 rounded-lg ${
            !canJudgeReadiness
              ? 'bg-neutral-500/10 text-neutral-500'
              : blockers === 0
                ? 'bg-emerald-500/10 text-emerald-500'
                : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
          }`}
        >
          {!canJudgeReadiness
            ? 'Overview only'
            : blockers === 0
              ? 'Ready for payroll'
              : `${blockers} items to resolve`}
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
        <StatPill label="Missing punches" value={missing} tone="violet" onClick={() => onNavigate?.('attendance')} />
        {canJudgeReadiness && (
          <StatPill label="Pending corrections" value={pendingRegs.length} tone="amber" onClick={() => onNavigate?.('attendance')} />
        )}
        <StatPill label="Undecided leaves" value={pendingLeaves} tone="amber" onClick={() => onNavigate?.('leave')} />
        <StatPill label="Late marks" value={late} tone="neutral" onClick={() => onNavigate?.('attendance')} />
        <StatPill label="Absences" value={absent} tone="red" onClick={() => onNavigate?.('attendance')} />
        <StatPill label="No shift assigned" value={noShift} tone="blue" onClick={() => onNavigate?.('attendance-admin')} />
      </div>
    </Widget>
  );
}

/** Onboarding pipeline: who's joining and how far along their checklist is. */
export function OnboardingPipeline({ onNavigate }) {
  const { data: rows = [] } = useOnboarding();
  const active = rows.filter((r) => (r.progress ?? 0) < 100);

  return (
    <Widget title="Onboarding" icon={UserPlus} badge={active.length || null} action="Board" onAction={() => onNavigate?.('onboarding')}>
      {active.length === 0 ? (
        <EmptyNote>No onboarding in progress.</EmptyNote>
      ) : (
        <div className="space-y-1.5">
          {active.slice(0, 4).map((r) => (
            <button
              key={r.id}
              onClick={() => onNavigate?.('onboarding')}
              className="w-full text-left rounded-lg border border-neutral-200/60 dark:border-neutral-850 px-2.5 py-2 cursor-pointer hover:border-[#0ea971]/40 transition-colors"
            >
              <div className="mobile-list-row flex items-center justify-between">
                <span className="text-base font-semibold text-neutral-700 dark:text-warm-gray-200 truncate">
                  {r.name}
                </span>
                <span className="text-2xs text-neutral-450 dark:text-neutral-500 shrink-0">
                  {r.join_date ? `joins ${fmtDay(r.join_date)}` : r.job_title}
                </span>
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <div className="h-1 flex-1 rounded-full bg-neutral-150 dark:bg-charcoal-800 overflow-hidden">
                  <div className="h-full rounded-full bg-[#0ea971]" style={{ width: `${r.progress ?? 0}%` }} />
                </div>
                <span className="text-2xs font-mono font-bold text-neutral-500">{r.progress ?? 0}%</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </Widget>
  );
}

/** Exit pipeline: separations in progress with clearance status. */
export function ExitPipeline({ onNavigate }) {
  const { data: rows = [] } = useExits();
  const active = rows.filter((r) => r.status !== 'Completed' && r.status !== 'Cleared');

  return (
    <Widget title="Exits In Progress" icon={DoorOpen} badge={active.length || null} action="Manage" onAction={() => onNavigate?.('helpdesk')}>
      {active.length === 0 ? (
        <EmptyNote>No separations in progress.</EmptyNote>
      ) : (
        <div className="space-y-1.5">
          {active.slice(0, 4).map((r) => (
            <button
              key={r.id}
              onClick={() => onNavigate?.('helpdesk')}
              className="w-full text-left flex items-center gap-2.5 rounded-lg border border-neutral-200/60 dark:border-neutral-850 px-2.5 py-1.5 cursor-pointer hover:border-[#0ea971]/40 transition-colors"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-base font-semibold text-neutral-700 dark:text-warm-gray-200 truncate">
                  {r.employee?.full_name || 'Employee'}
                </span>
                <span className="block text-2xs text-neutral-450 dark:text-neutral-500 truncate">
                  {r.reason} · last day {fmtDay(r.last_day)}
                </span>
              </span>
              <StatusBadge status={r.status} />
            </button>
          ))}
        </div>
      )}
    </Widget>
  );
}

/** Recruitment funnel: open roles and candidates by stage. */
export function RecruitmentOverview({ onNavigate }) {
  const { data: jobs = [] } = useJobs();
  const { data: candidates = [] } = useCandidates();
  const open = jobs.filter((j) => j.status === 'Open');
  const openings = open.reduce((n, j) => n + (j.openings || 0), 0);
  const byStage = Object.entries(
    candidates.reduce((m, c) => {
      m[c.stage] = (m[c.stage] || 0) + 1;
      return m;
    }, {})
  );

  return (
    <Widget title="Recruitment" icon={Briefcase} badge={open.length || null} action="Hub" onAction={() => onNavigate?.('recruitment')}>
      <button
        onClick={() => onNavigate?.('recruitment')}
        className="w-full mb-2 flex items-center justify-between rounded-lg border border-neutral-200/60 dark:border-neutral-850 px-2.5 py-1.5 cursor-pointer hover:border-[#0ea971]/40 transition-colors"
      >
        <span className="text-base font-semibold text-neutral-700 dark:text-warm-gray-200">Open positions</span>
        <span className="text-xs font-bold font-mono text-neutral-900 dark:text-white">
          {open.length} roles · {openings} seats
        </span>
      </button>
      {byStage.length === 0 ? (
        <EmptyNote>No candidates in the pipeline.</EmptyNote>
      ) : (
        <div className="grid grid-cols-2 gap-1.5">
          {byStage.map(([stage, count]) => (
            <StatPill key={stage} label={stage} value={count} tone="neutral" onClick={() => onNavigate?.('recruitment')} />
          ))}
        </div>
      )}
    </Widget>
  );
}


/** Month-to-date expense spend: approved total plus pending queue value. */
export function ExpenseSpend({ onNavigate }) {
  const { data: expenses = [] } = useExpenses();
  const start = monthStart();
  const mtd = expenses.filter((e) => (e.expense_date || '') >= start);
  const approved = mtd.filter((e) => e.status === 'Approved' || e.status === 'Paid');
  const pending = mtd.filter((e) => e.status === 'Pending');
  const sum = (rows) => rows.reduce((n, e) => n + Number(e.amount || 0), 0);

  return (
    <Widget title="Expense Spend (MTD)" icon={ReceiptText} action="Claims" onAction={() => onNavigate?.('expense')}>
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => onNavigate?.('expense')}
          className="text-left rounded-xl border border-neutral-200/70 dark:border-neutral-850 px-3 py-2.5 cursor-pointer hover:border-[#0ea971]/40 transition-colors"
        >
          <p className="text-sm font-bold font-mono text-neutral-900 dark:text-white leading-none">{inr(sum(approved))}</p>
          <p className="mt-1.5 text-xs font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
            Approved · {approved.length}
          </p>
        </button>
        <button
          onClick={() => onNavigate?.('expense')}
          className="text-left rounded-xl border border-neutral-200/70 dark:border-neutral-850 px-3 py-2.5 cursor-pointer hover:border-[#0ea971]/40 transition-colors"
        >
          <p className="text-sm font-bold font-mono text-neutral-900 dark:text-white leading-none">{inr(sum(pending))}</p>
          <p className="mt-1.5 text-xs font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">
            Pending · {pending.length}
          </p>
        </button>
      </div>
    </Widget>
  );
}

/** Document vault snapshot: unsigned documents that need chasing, plus the latest uploads. */
export function DocumentsSnapshot({ onNavigate }) {
  const { data: documents = [] } = useDocuments();
  const unsigned = documents.filter((d) => d.signed === false);

  return (
    <Widget title="Documents" icon={FolderOpen} badge={unsigned.length ? `${unsigned.length} unsigned` : null} action="Vault" onAction={() => onNavigate?.('documents')}>
      {documents.length === 0 ? (
        <EmptyNote>No documents in your scope.</EmptyNote>
      ) : (
        <div className="space-y-1.5">
          {(unsigned.length > 0 ? unsigned : documents).slice(0, 4).map((d) => (
            <button
              key={d.id}
              onClick={() => onNavigate?.('documents')}
              className="w-full text-left flex items-center gap-2.5 rounded-lg border border-neutral-200/60 dark:border-neutral-850 px-2.5 py-1.5 cursor-pointer hover:border-[#0ea971]/40 transition-colors"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-base font-semibold text-neutral-700 dark:text-warm-gray-200 truncate">{d.title}</span>
                <span className="block text-2xs text-neutral-450 dark:text-neutral-500 truncate">
                  {d.category}{d.employee?.full_name ? ` · ${d.employee.full_name}` : ''}
                </span>
              </span>
              <span
                className={`text-2xs font-mono font-bold px-1.5 py-0.5 rounded border leading-none shrink-0 ${
                  d.signed
                    ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'
                    : 'bg-amber-500/10 text-amber-500 border-amber-500/20'
                }`}
              >
                {d.signed ? 'Signed' : 'Unsigned'}
              </span>
            </button>
          ))}
        </div>
      )}
    </Widget>
  );
}

/** Biometric device + sync health. Only meaningful to holders of device.manage. */
export function DeviceHealth({ onNavigate }) {
  const { data: devices = [] } = useDevices();
  const { data: syncState = [] } = useSyncState();
  const { data: runs = [] } = useSyncRuns(5);

  const stale = devices.filter(
    (d) => d.is_active && (!d.last_punch_at || Date.now() - new Date(d.last_punch_at).getTime() > 24 * 3600_000)
  );
  // The punch channel is keyed 'transactions' (0012 seeds transactions/employees/devices);
  // 'punches' never matched, so this silently reported a random channel's health.
  const punchSync = syncState.find((s) => s.key === 'transactions') ?? null;
  const failedRuns = runs.filter((r) => r.status === 'failed').length;

  return (
    <Widget title="Devices & Sync" icon={Fingerprint} action="Setup" onAction={() => onNavigate?.('attendance-admin')}>
      <div className="grid grid-cols-3 gap-1.5 mb-3">
        <StatPill label="Devices" value={devices.length} tone="neutral" onClick={() => onNavigate?.('attendance-admin')} />
        <StatPill label="Quiet 24h+" value={stale.length} tone={stale.length ? 'amber' : 'green'} onClick={() => onNavigate?.('attendance-admin')} />
        <StatPill label="Failed runs" value={failedRuns} tone={failedRuns ? 'red' : 'green'} onClick={() => onNavigate?.('attendance-admin')} />
      </div>
      <div className="rounded-lg border border-neutral-200/60 dark:border-neutral-850 px-2.5 py-2 space-y-1">
        <div className="flex items-center justify-between text-2xs">
          <span className="font-semibold text-neutral-600 dark:text-neutral-300">Last successful sync</span>
          <span className="font-mono font-bold text-neutral-800 dark:text-warm-gray-100">
            {punchSync?.last_success_at ? relativeTime(punchSync.last_success_at) : '—'}
          </span>
        </div>
        {punchSync?.last_error && (
          <p className="text-2xs text-rose-500 truncate" title={punchSync.last_error} aria-label={punchSync.last_error}>
            {punchSync.last_error}
          </p>
        )}
        {(punchSync?.consecutive_failures ?? 0) > 0 && (
          <p className="text-2xs font-bold text-amber-600 dark:text-amber-400">
            {punchSync.consecutive_failures} consecutive failures
          </p>
        )}
      </div>
    </Widget>
  );
}

/** Users & access: login coverage and gaps. Gated by rbac.manage at the call site. */
export function UserAccessPanel({ onNavigate }) {
  const { data: users = [] } = useManagedUsers();
  const noRole = users.filter((u) => !u.is_super_admin && (u.roles || []).length === 0);
  const noEmployee = users.filter((u) => !u.employee_id && !u.is_super_admin);

  return (
    <Widget title="Users & Access" icon={ShieldCheck} badge={users.length || null} action="Administration" onAction={() => onNavigate?.('administration')}>
      <div className="grid grid-cols-3 gap-1.5 mb-3">
        <StatPill label="Logins" value={users.length} tone="neutral" onClick={() => onNavigate?.('administration')} />
        <StatPill label="No role" value={noRole.length} tone={noRole.length ? 'amber' : 'green'} onClick={() => onNavigate?.('administration')} />
        <StatPill label="Unlinked" value={noEmployee.length} tone={noEmployee.length ? 'amber' : 'green'} onClick={() => onNavigate?.('administration')} />
      </div>
      {noRole.slice(0, 3).map((u) => (
        <button
          key={u.user_id}
          onClick={() => onNavigate?.('administration')}
          className="w-full text-left flex items-center justify-between rounded-lg border border-amber-500/20 bg-amber-500/5 px-2.5 py-1.5 mb-1.5 cursor-pointer hover:border-amber-500/40 transition-colors"
        >
          <span className="text-base font-semibold text-neutral-700 dark:text-warm-gray-200 truncate">{u.email}</span>
          <span className="text-2xs font-bold text-amber-600 dark:text-amber-400 shrink-0">needs a role</span>
        </button>
      ))}
    </Widget>
  );
}

/** Latest privileged actions from the audit log. */
export function AuditFeed({ onNavigate }) {
  const { data: rows = [] } = useAuditLog();

  return (
    <Widget title="Audit Trail" icon={ScrollText} action="Administration" onAction={() => onNavigate?.('administration')}>
      {rows.length === 0 ? (
        <EmptyNote>No audit entries visible.</EmptyNote>
      ) : (
        <div className="space-y-1.5">
          {rows.slice(0, 6).map((r) => (
            <button
              key={r.id}
              onClick={() => onNavigate?.('administration')}
              className="w-full text-left flex items-center gap-2 rounded-lg border border-neutral-200/60 dark:border-neutral-850 px-2.5 py-1.5 cursor-pointer hover:border-[#0ea971]/40 transition-colors"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-base font-semibold text-neutral-700 dark:text-warm-gray-200 truncate">
                  <span className="font-mono text-[#0ea971]">{r.action}</span> · {r.table_name}
                </span>
                <span className="block text-2xs text-neutral-450 dark:text-neutral-500 truncate">{r.actor_email}</span>
              </span>
              <span className="text-2xs font-mono text-neutral-400 shrink-0">{relTime(r.created_at)}</span>
            </button>
          ))}
        </div>
      )}
    </Widget>
  );
}

/** Per-branch comparison table: headcount, present/late/absent today, pending leaves. */
export function BranchComparison({ onNavigate }) {
  const { data: employees = [] } = useEmployees();
  const { data: dayRows = [] } = useDayAttendance(todayIso());
  const { data: leaves = [] } = useLeaves();

  const branches = {};
  const bucket = (code) =>
    (branches[code] ||= { code, headcount: 0, present: 0, late: 0, absent: 0, pending: 0 });

  employees.forEach((e) => {
    if (e.status === 'Active') bucket(e.branch?.code || '—').headcount += 1;
  });
  dayRows.forEach((r) => {
    const b = bucket(r.employee?.branch?.code || '—');
    if (r.check_in) b.present += 1;
    if (r.is_late) b.late += 1;
    if (r.status === 'Absent') b.absent += 1;
  });
  leaves.forEach((l) => {
    if (l.status === 'Pending') bucket(l.employee?.branch?.code || '—').pending += 1;
  });

  const rows = Object.values(branches).sort((a, b) => b.headcount - a.headcount).slice(0, 10);

  return (
    <Widget title="Branch Comparison" icon={Building2} action="Directory" onAction={() => onNavigate?.('directory')}>
      {rows.length === 0 ? (
        <EmptyNote>No branch data in your scope.</EmptyNote>
      ) : (
        <div className="table-scroll">
          <table className="premium-table w-full text-left">
            <thead>
              <tr className="text-xs font-bold uppercase tracking-wider text-neutral-450 dark:text-neutral-500 border-b border-neutral-200/70 dark:border-neutral-850">
                <th className="py-1.5 pr-2">Branch</th>
                <th className="py-1.5 px-2 text-right">Staff</th>
                <th className="py-1.5 px-2 text-right">In</th>
                <th className="py-1.5 px-2 text-right">Late</th>
                <th className="py-1.5 px-2 text-right">Absent</th>
                <th className="py-1.5 pl-2 text-right">Pending</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr
                  key={b.code}
                  onClick={() => onNavigate?.('attendance')}
                  className="border-b border-neutral-100 dark:border-neutral-900/60 last:border-0 text-xs cursor-pointer hover:bg-neutral-50 dark:hover:bg-charcoal-800/40 transition-colors"
                >
                  <td data-label="Branch" className="py-1.5 pr-2 font-bold text-neutral-800 dark:text-warm-gray-100 font-mono">{b.code}</td>
                  <td data-label="Staff" className="py-1.5 px-2 text-right font-mono text-neutral-600 dark:text-neutral-300">{b.headcount}</td>
                  <td data-label="In" className="py-1.5 px-2 text-right font-mono text-emerald-600 dark:text-emerald-400">{b.present}</td>
                  <td data-label="Late" className={`py-1.5 px-2 text-right font-mono ${b.late ? 'text-amber-600 dark:text-amber-400 font-bold' : 'text-neutral-400'}`}>{b.late}</td>
                  <td data-label="Absent" className={`py-1.5 px-2 text-right font-mono ${b.absent ? 'text-rose-500 font-bold' : 'text-neutral-400'}`}>{b.absent}</td>
                  <td data-label="Pending" className={`py-1.5 pl-2 text-right font-mono ${b.pending ? 'text-amber-600 dark:text-amber-400 font-bold' : 'text-neutral-400'}`}>{b.pending}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Widget>
  );
}

/** Per-entity comparison for the super admin: headcount and live presence per company. */
export function EntityComparison({ onNavigate }) {
  const { data: employees = [] } = useEmployees();
  const { data: dayRows = [] } = useDayAttendance(todayIso());

  const entities = {};
  const bucket = (code) => (entities[code] ||= { code, headcount: 0, present: 0, absent: 0, onLeave: 0 });

  employees.forEach((e) => {
    if (e.status === 'Active') bucket(e.entity?.code || '—').headcount += 1;
  });
  dayRows.forEach((r) => {
    // Attendance rows don't join the entity, so resolve it through the employee list.
    const emp = employees.find((e) => e.id === r.employee?.id);
    const b = bucket(emp?.entity?.code || '—');
    if (r.check_in) b.present += 1;
    if (r.status === 'Absent') b.absent += 1;
    if (r.status === 'On Leave') b.onLeave += 1;
  });

  const rows = Object.values(entities).sort((a, b) => b.headcount - a.headcount);

  return (
    <Widget title="Entities at a Glance" icon={Network} action={onNavigate ? "Org" : null} onAction={() => onNavigate?.('organization')}>
      {rows.length === 0 ? (
        <EmptyNote>No entities visible.</EmptyNote>
      ) : (
        <div className="table-scroll">
          <table className="premium-table w-full text-left">
            <thead>
              <tr className="text-xs font-bold uppercase tracking-wider text-neutral-450 dark:text-neutral-500 border-b border-neutral-200/70 dark:border-neutral-850">
                <th className="py-1.5 pr-2">Entity</th>
                <th className="py-1.5 px-2 text-right">Headcount</th>
                <th className="py-1.5 px-2 text-right">Present</th>
                <th className="py-1.5 px-2 text-right">Absent</th>
                <th className="py-1.5 pl-2 text-right">On leave</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr
                  key={e.code}
                  onClick={() => onNavigate?.('organization')}
                  className="border-b border-neutral-100 dark:border-neutral-900/60 last:border-0 text-xs cursor-pointer hover:bg-neutral-50 dark:hover:bg-charcoal-800/40 transition-colors"
                >
                  <td data-label="Entity" className="py-1.5 pr-2 font-bold text-neutral-800 dark:text-warm-gray-100 font-mono">{e.code}</td>
                  <td data-label="Headcount" className="py-1.5 px-2 text-right font-mono text-neutral-600 dark:text-neutral-300">{e.headcount}</td>
                  <td data-label="Present" className="py-1.5 px-2 text-right font-mono text-emerald-600 dark:text-emerald-400">{e.present}</td>
                  <td data-label="Absent" className={`py-1.5 px-2 text-right font-mono ${e.absent ? 'text-rose-500 font-bold' : 'text-neutral-400'}`}>{e.absent}</td>
                  <td data-label="On leave" className="py-1.5 pl-2 text-right font-mono text-blue-500">{e.onLeave}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Widget>
  );
}
