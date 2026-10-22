// Approvals (round 2, after the reference phone kit): everything waiting for your decision in one
// place — leave, attendance corrections and expenses — one card per request with Reject and
// Approve. Only requests you may actually decide are listed (useActionableApprovals), the same
// rule the Home inbox and the full screens use. Leave needs a remark and has more than two
// outcomes (forward to HR, sanction, hold), so its buttons open the leave review panel.
import React, { useState } from 'react';
import { Check, X, CalendarDays, Clock, ReceiptText, CheckCheck } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { usePermissions } from '../auth/usePermissions';
import { useLeaves } from '../data/leaves';
import { useLeaveTypes } from '../data/leaveTypes';
import { useExpenses, useSetExpenseStatus } from '../data/expenses';
import { useRegularizations, useDecideRegularization } from '../data/regularizations';
import { useActionableApprovals } from './dashboard/useActionableApprovals';
import { fmtDay, inr } from './dashboard/shared';
import { leaveStageLabel } from '../lib/leaveWorkflow';
import LeaveReviewPanel from './LeaveReviewPanel';
import PageHeader from './ui/PageHeader';
import Avatar from './ui/Avatar';
import { SkeletonRows } from './ui/Skeleton';
import './approvals.css';

/** "Today", "Yesterday", "3 days ago" — how long a request has been waiting. */
export function waitingSince(iso, now = new Date()) {
  if (!iso) return '';
  const days = Math.floor((now - new Date(iso)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return `${days} days ago`;
}

export default function Approvals() {
  const { employee } = useAuth();
  const { canAny } = usePermissions();
  const leaveQuery = useLeaves();
  const expenseQuery = useExpenses();
  const regQuery = useRegularizations('Pending');
  const setExpenseStatus = useSetExpenseStatus();
  const decideReg = useDecideRegularization();
  const [reviewLeaveId, setReviewLeaveId] = useState(null);
  // Which button opened the review, so Reject opens it with Reject already chosen.
  const [reviewIntent, setReviewIntent] = useState(null);
  const approvals = useActionableApprovals({ leaves: leaveQuery.data ?? [], expenses: expenseQuery.data ?? [], regs: regQuery.data ?? [] });

  const tabs = [
    canAny('leave.approve') && { id: 'leave', label: 'Leave', rows: approvals.leaves, icon: CalendarDays, query: leaveQuery },
    canAny('regularization.approve') && { id: 'attendance', label: 'Attendance', rows: approvals.punches, icon: Clock, query: regQuery },
    canAny('expense.approve') && { id: 'expense', label: 'Expenses', rows: approvals.expenses, icon: ReceiptText, query: expenseQuery },
  ].filter(Boolean);
  const [active, setActive] = useState(() => (tabs.find((t) => t.rows.length) ?? tabs[0])?.id);
  const tab = tabs.find((t) => t.id === active) ?? tabs[0];
  const busy = setExpenseStatus.isPending || decideReg.isPending;
  const failure = setExpenseStatus.error || decideReg.error || tab?.query.error;
  const reviewLeave = (leaveQuery.data ?? []).find((row) => row.id === reviewLeaveId);
  const { data: leaveTypes = [] } = useLeaveTypes();
  const leaveName = (code) => leaveTypes.find((t) => t.code === code)?.name ?? `${code} leave`;

  const decide = (row, approve) => {
    setExpenseStatus.reset();
    decideReg.reset();
    if (tab.id === 'leave') { setReviewIntent(approve ? 'Approved' : 'Rejected'); setReviewLeaveId(row.id); }
    else if (tab.id === 'expense') setExpenseStatus.mutate({ id: row.id, status: approve ? 'Approved' : 'Rejected', approverEmployeeId: employee?.id });
    else decideReg.mutate({ id: row.id, decision: approve ? 'Approved' : 'Rejected' });
  };

  const describe = (row) => {
    if (tab.id === 'leave') return { what: leaveName(row.type), when: `${fmtDay(row.start_date)}${row.end_date !== row.start_date ? ` – ${fmtDay(row.end_date)}` : ''} · ${row.days} day${Number(row.days) === 1 ? '' : 's'}`, note: leaveStageLabel(row) };
    if (tab.id === 'expense') return { what: `${row.category} · ${inr(row.amount)}`, when: fmtDay(row.expense_date), note: row.description };
    return { what: 'Attendance correction', when: fmtDay(row.work_date), note: row.reason };
  };

  return (
    <div className="page-shell space-y-5 animate-slide-up approvals-page">
      <PageHeader title="Approvals" subtitle="Requests waiting for your decision." />
      {reviewLeave && <LeaveReviewPanel key={`${reviewLeave.id}:${reviewIntent}`} request={reviewLeave} initialDecision={reviewIntent} onClose={() => setReviewLeaveId(null)} />}

      {tabs.length === 0 ? (
        <p className="premium-card p-8 text-center text-sm text-neutral-500">You have no approvals to make.</p>
      ) : <>
        <nav aria-label="Kinds of request" className="mobile-segmented approvals-tabs">
          {tabs.map((t) => (
            <button key={t.id} type="button" onClick={() => setActive(t.id)} aria-pressed={tab.id === t.id}
              className={`drawer-tab ${tab.id === t.id ? 'drawer-tab-active' : ''}`}>
              {t.label}<span className="approvals-count">{t.rows.length}</span>
            </button>
          ))}
        </nav>

        {failure && <p role="alert" className="approvals-error">{failure.message}</p>}

        {tab.query.isLoading ? <SkeletonRows rows={3} label="Loading requests" /> : tab.rows.length === 0 ? (
          <p className="premium-card approvals-empty"><CheckCheck size={20} aria-hidden="true" /> Nothing waiting — you are all caught up.</p>
        ) : (
          <div className="approvals-list">
            {tab.rows.map((row) => {
              const { what, when, note } = describe(row);
              return (
                <article key={row.id} className="premium-card approval-card">
                  <div className="approval-card-head">
                    <Avatar name={row.employee?.full_name} />
                    <div className="approval-card-copy">
                      <strong>{row.employee?.full_name || 'Employee'}</strong>
                      <span>{what}</span>
                      <span>{when}</span>
                    </div>
                    <small>{waitingSince(row.created_at)}</small>
                  </div>
                  {note && <p className="approval-card-note">{note}</p>}
                  <div className="approval-card-actions">
                    <button type="button" className="approval-reject" disabled={busy} onClick={() => decide(row, false)}
                      aria-label={`Reject ${what} for ${row.employee?.full_name || 'this employee'}`}>
                      <X size={15} aria-hidden="true" /> Reject
                    </button>
                    <button type="button" className="approval-approve" disabled={busy} onClick={() => decide(row, true)}
                      aria-label={`Approve ${what} for ${row.employee?.full_name || 'this employee'}`}>
                      <Check size={15} aria-hidden="true" /> Approve
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </>}
    </div>
  );
}
