import React, { useState } from 'react';
import { ArrowRight, CalendarClock, CalendarDays, CheckCheck, ChevronDown, Clock,
  CircleAlert, LifeBuoy, ListTodo, MessageSquare, ReceiptText } from 'lucide-react';
import { useAuth } from '../../auth/AuthContext';
import { usePermissions } from '../../auth/usePermissions';
import { useMessageInbox } from '../../data/messages';
import { useTasks } from '../../data/tasks';
import { useUnreadTaskAssignments } from '../../data/notifications';
import { useLeaves } from '../../data/leaves';
import { useExpenses } from '../../data/expenses';
import { useRegularizations } from '../../data/regularizations';
import { useTickets } from '../../data/tickets';
import { useMyDepartments } from '../../data/team';
import { useHelpRequests } from '../../data/helpRequests';
import { incomingRequests } from '../../lib/helpRequests';
import { useIstToday } from '../../lib/useIstToday';
import { dashboardActions } from '../../lib/dashboardActions';
import { useActionableApprovals } from './useActionableApprovals';
import './actionCenter.css';

const ICONS = { messages: MessageSquare, tasks: ListTodo, overdue: CircleAlert, due: CalendarClock,
  blocked: CircleAlert, leave: CalendarDays, expense: ReceiptText, attendance: Clock, help: LifeBuoy };

export default function ActionCenter({ onNavigate }) {
  const { employee } = useAuth();
  const { can, canAny, viewingAsEmployee } = usePermissions();
  const today = useIstToday();
  const tasksEnabled = Boolean(employee?.id) && canAny('task.read');
  const leavesEnabled = !viewingAsEmployee && canAny('leave.approve');
  const expensesEnabled = !viewingAsEmployee && canAny('expense.approve');
  const correctionsEnabled = !viewingAsEmployee && canAny('regularization.approve');
  const ticketsEnabled = !viewingAsEmployee && canAny('ticket.manage');
  const inbox = useMessageInbox();
  const tasks = useTasks({ enabled: tasksEnabled });
  const assignments = useUnreadTaskAssignments({ enabled: tasksEnabled });
  const leaves = useLeaves({ enabled: leavesEnabled });
  const expenses = useExpenses({ enabled: expensesEnabled });
  const corrections = useRegularizations('Pending', undefined, { enabled: correctionsEnabled });
  const tickets = useTickets({ enabled: ticketsEnabled });
  const helpEnabled = !viewingAsEmployee && canAny('task.request');
  const departments = useMyDepartments({ enabled: helpEnabled });
  const help = useHelpRequests({ enabled: helpEnabled });
  const approvals = useActionableApprovals({ leaves: leaves.data, expenses: expenses.data, regs: corrections.data });
  const manageableTickets = ticketsEnabled ? (tickets.data ?? []).filter((t) =>
    ['Open', 'In Progress', 'On Hold'].includes(t.status) && can('ticket.manage', {
      entityId: t.entity_id, zoneId: t.zone_id, branchId: t.branch_id, deptId: t.department_id, employeeId: t.employee_id,
    })) : [];
  const requests = helpEnabled ? incomingRequests(help.data, (departments.data ?? []).map((d) => d.id))
    .filter((r) => r.status === 'Pending') : [];
  const actions = dashboardActions({ employeeId: employee?.id, today, conversations: inbox.data,
    tasks: tasksEnabled ? tasks.data : [], assignments: assignments.data,
    approvals: viewingAsEmployee ? {} : approvals, tickets: manageableTickets, helpRequests: requests });
  const queries = [employee?.id && inbox, tasksEnabled && tasks, tasksEnabled && assignments,
    leavesEnabled && leaves, expensesEnabled && expenses, correctionsEnabled && corrections,
    ticketsEnabled && tickets, helpEnabled && departments, helpEnabled && help].filter(Boolean);
  const loading = queries.some((q) => q.isLoading);
  const failed = queries.some((q) => q.isError);
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? actions : actions.slice(0, 4);

  return (
    <section className="premium-card home-actions" aria-label="Your actions">
      <header className="home-actions-header">
        <div>
          <h2>Your actions</h2>
          <p>Messages, deadlines and requests waiting for you</p>
        </div>
        <button type="button" className="home-actions-updates" onClick={() => onNavigate?.('notifications')}>
          All updates <ArrowRight size={14} />
        </button>
      </header>
      {visible.length > 0 && <div className="home-actions-grid">
        {visible.map((item) => {
          const Icon = ICONS[item.icon];
          return <button type="button" key={item.id} className="home-action" data-tone={item.tone}
            onClick={() => onNavigate?.(item.target)}>
            <span className="home-action-icon"><Icon size={19} /></span>
            <span className="home-action-copy"><strong>{item.title}</strong><span>{item.detail}</span></span>
            <ArrowRight size={16} className="home-action-arrow" />
          </button>;
        })}
      </div>}
      {actions.length > 4 && <button className="home-actions-more" type="button" aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}>
        {expanded ? 'Show fewer actions' : `Show ${actions.length - 4} more`} <ChevronDown size={15} />
      </button>}
      {loading && <p className="home-actions-status" role="status">Checking your latest actions…</p>}
      {failed && <p className="home-actions-status" role="status">Some actions could not be refreshed. <button type="button"
        onClick={() => queries.filter((q) => q.isError).forEach((q) => q.refetch())}>Try again</button></p>}
      {!actions.length && !loading && !failed && <p className="home-actions-empty"><CheckCheck size={19} /> You’re all caught up. No actions waiting.</p>}
    </section>
  );
}
