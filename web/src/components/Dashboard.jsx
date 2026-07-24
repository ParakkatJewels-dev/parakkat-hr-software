import React, { useMemo } from 'react';
import {
  Users, Building2, CalendarDays, CheckSquare, ReceiptText, LifeBuoy, Network,
  ArrowRight, BellRing, Megaphone, Check, Ban, Loader2, Search, Bell, Settings
} from 'lucide-react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, PieChart, Pie, Cell } from 'recharts';
import { useEmployees } from '../data/employees';
import { useLeaves, useSetLeaveStatus } from '../data/leaves';
import { useExpenses } from '../data/expenses';
import { useTickets } from '../data/tickets';
import { useOrg } from '../data/org';
import { useAuth } from '../auth/AuthContext';
import { usePermissions } from '../auth/usePermissions';

const BRAND_GREEN = '#0ea971';
const PIE = ['#0ea971', '#10b981', '#34d399', '#6b8f89', '#a2d6c9'];
const axis = { stroke: '#888888', fontSize: 9, tickLine: false, axisLine: false };

const chartTooltip = {
  contentStyle: { 
    background: 'rgba(17, 26, 22, 0.95)', 
    backdropFilter: 'blur(8px)',
    border: '1px solid rgba(16, 185, 129, 0.2)', 
    borderRadius: '12px', 
    color: '#e6f0eb', 
    fontSize: '11px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.25)'
  },
  itemStyle: { color: '#e6f0eb' },
};

const getInitials = (name) => {
  return (name || 'E').split(' ').filter(Boolean).slice(0, 2).map((s) => s[0]).join('').toUpperCase();
};

export default function Dashboard({ onNavigate }) {
  const { data: employees = [] } = useEmployees();
  const { data: leaves = [] } = useLeaves();
  const { data: expenses = [] } = useExpenses();
  const { data: tickets = [] } = useTickets();
  const { data: org } = useOrg();
  const { employee, user } = useAuth();
  const { canAny, canBeyondSelf } = usePermissions();
  const setLeaveStatus = useSetLeaveStatus();

  const canApprove = canAny('leave.approve');
  // Oversight user = can see/act on other people's data. Employees (self-scoped) see an ESS view.
  const isOversight =
    canBeyondSelf('employee.read') || canAny('org.manage') || canApprove || canAny('expense.approve');
  
  const displayName = employee?.full_name || user?.email || 'Davis Levin';
  const greetingName = displayName.split(' ')[0];
  const userInitials = getInitials(displayName);

  const a = useMemo(() => {
    const pendingLeaves = leaves.filter((l) => l.status === 'Pending');
    const pendingExpenses = expenses.filter((e) => e.status === 'Pending');
    const openTickets = tickets.filter((t) => t.status !== 'Resolved').length;

    const byEntity = Object.entries(
      employees.reduce((m, e) => {
        const k = e.entity?.code || '—';
        m[k] = (m[k] || 0) + 1;
        return m;
      }, {})
    ).map(([name, count]) => ({ name, count }));

    const leaveStatus = Object.entries(
      leaves.reduce((m, l) => {
        m[l.status] = (m[l.status] || 0) + 1;
        return m;
      }, {})
    ).map(([name, value]) => ({ name, value }));

    return { pendingLeaves, pendingExpenses, openTickets, byEntity, leaveStatus };
  }, [employees, leaves, expenses, tickets]);

  // Org-wide KPIs are for oversight users only; employees get a self-service summary.
  const kpis = [
    isOversight && { label: 'Employees', value: employees.length, icon: Users, badgeClass: 'bg-[#0ea971]/10 text-[#0ea971]', subtext: "In your scope" },
    isOversight && { label: 'Branches', value: (org?.branches ?? []).length, icon: Building2, badgeClass: 'bg-blue-500/10 text-blue-500', subtext: "Active across key regions" },
    isOversight && { label: 'Entities', value: (org?.entities ?? []).length, icon: Network, badgeClass: 'bg-purple-500/10 text-purple-500', subtext: "Corporate companies mapped" },
    { label: isOversight ? 'Pending Leaves' : 'My Pending Leaves', value: a.pendingLeaves.length, icon: CalendarDays, badgeClass: 'bg-amber-500/10 text-amber-500', subtext: isOversight ? "Requires your approval" : "Awaiting approval" },
    { label: isOversight ? 'Pending Expenses' : 'My Pending Expenses', value: a.pendingExpenses.length, icon: ReceiptText, badgeClass: 'bg-orange-500/10 text-orange-500', subtext: isOversight ? "Awaiting validation" : "Submitted for review" },
    { label: isOversight ? 'Open Tickets' : 'My Open Tickets', value: a.openTickets, icon: LifeBuoy, badgeClass: 'bg-rose-500/10 text-rose-500', subtext: isOversight ? "Assigned for resolution" : "Being handled" },
  ].filter(Boolean);

  // Quick actions filtered by permission: oversight shortcuts only for those who hold them; everyone
  // gets the self-service actions they're permitted (apply leave, submit expense, raise ticket).
  const quickActions = [
    canApprove && { label: 'Review Leaves', tab: 'leave', icon: CalendarDays },
    canAny('expense.approve') && { label: 'Review Expenses', tab: 'expense', icon: ReceiptText },
    canBeyondSelf('employee.read') && { label: 'Employee Directory', tab: 'directory', icon: Users },
    canAny('org.manage') && { label: 'Organization Hierarchy', tab: 'organization', icon: Network },
    canAny('leave.create') && { label: 'Apply for Leave', tab: 'leave', icon: CalendarDays },
    canAny('expense.create') && { label: 'Submit Expense', tab: 'expense', icon: ReceiptText },
    canAny('ticket.create') && { label: 'Raise a Ticket', tab: 'helpdesk', icon: LifeBuoy },
    canAny('task.read') && { label: 'My Tasks', tab: 'tasks', icon: CheckSquare },
  ].filter(Boolean).slice(0, 8);

  return (
    <div className="page-shell space-y-5 animate-slide-up">
      

      {/* KPI Cards Grid */}
      <section className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        {kpis.map(({ label, value, icon: Icon, badgeClass, subtext }) => (
          <article key={label} className="premium-card p-4 flex flex-col justify-between hover:-translate-y-0.5 hover:shadow-md transition-all duration-300">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-455">{label}</span>
              <div className={`shrink-0 flex items-center justify-center rounded-full w-7 h-7 ${badgeClass}`}>
                <Icon size={12} />
              </div>
            </div>
            <div className="mt-2.5 pt-2 border-t border-neutral-100 dark:border-neutral-850">
              <p className="text-xl font-bold tracking-tight text-neutral-900 dark:text-white leading-none">{value}</p>
              {subtext && (
                <span className="text-[9px] text-[#0ea971] dark:text-[#10b981] font-semibold mt-1.5 block truncate leading-none">
                  {subtext}
                </span>
              )}
            </div>
          </article>
        ))}
      </section>

      {/* Main Multi-Column Split Layout */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        
        {/* Left Side: Charts and Quick Actions */}
        <div className="space-y-4 xl:col-span-8">
          <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            
            {/* Bar Chart card */}
            <article className="premium-card p-4">
              <div className="mb-3">
                <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">Headcount by Entity</h3>
                <p className="mt-0.5 text-[11px] text-neutral-400">Employees visible to you, per company</p>
              </div>
              <div className="h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={a.byEntity} margin={{ top: 8, right: 6, left: -24, bottom: 4 }}>
                    <defs>
                      <linearGradient id="barGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={BRAND_GREEN} stopOpacity={0.95} />
                        <stop offset="100%" stopColor={BRAND_GREEN} stopOpacity={0.15} />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="name" {...axis} />
                    <YAxis {...axis} />
                    <Tooltip {...chartTooltip} cursor={{ fill: 'rgba(16,185,129,0.03)' }} />
                    <Bar dataKey="count" fill="url(#barGradient)" radius={[4, 4, 0, 0]} maxBarSize={36} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </article>

            {/* Donut Chart card */}
            <article className="premium-card p-4">
              <div className="mb-3">
                <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">Leave Requests</h3>
                <p className="mt-0.5 text-[11px] text-neutral-400">By status, within your scope</p>
              </div>
              {a.leaveStatus.length === 0 ? (
                <div className="flex h-52 items-center justify-center text-[11px] text-neutral-400">No leave data yet.</div>
              ) : (
                <div className="flex h-52 items-center gap-3 relative">
                  <div className="h-full min-w-0 flex-1 relative flex items-center justify-center">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie 
                          data={a.leaveStatus} 
                          dataKey="value" 
                          innerRadius={50} 
                          outerRadius={70} 
                          paddingAngle={3}
                        >
                          {a.leaveStatus.map((it, i) => (
                            <Cell key={it.name} fill={PIE[i % PIE.length]} />
                          ))}
                        </Pie>
                        <Tooltip {...chartTooltip} />
                      </PieChart>
                    </ResponsiveContainer>
                    {/* Centered Donut Label */}
                    <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none select-none">
                      <span className="text-lg font-bold text-neutral-900 dark:text-white leading-none">
                        {leaves.length}
                      </span>
                      <span className="text-[9px] uppercase tracking-wider text-neutral-450 dark:text-neutral-500 font-bold mt-0.5">
                        Total
                      </span>
                    </div>
                  </div>
                  <div className="w-28 space-y-1.5 shrink-0">
                    {a.leaveStatus.map((it, i) => (
                      <div key={it.name} className="flex items-center gap-2 text-[10px] text-neutral-550 dark:text-warm-gray-400">
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: PIE[i % PIE.length] }} />
                        <span className="truncate font-semibold">{it.name}</span>
                        <span className="ml-auto font-mono text-[9px] bg-neutral-100 dark:bg-charcoal-800 px-1.5 py-0.2 rounded font-bold">{it.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </article>
          </section>

          {/* Quick Actions Panel */}
          <section className="premium-card p-4">
            <div className="mb-3 flex items-center gap-2">
              <CheckSquare size={14} className="text-[#0ea971]" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">Quick Actions</h3>
            </div>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
              {quickActions.map(({ label, tab, icon: Icon }) => (
                <button
                  key={label}
                  onClick={() => onNavigate?.(tab)}
                  className="flex items-center justify-between rounded-xl border border-neutral-200/80 bg-neutral-50/50 px-3.5 py-2.5 text-left text-xs font-semibold text-neutral-700 hover:text-neutral-900 hover:border-neutral-355 dark:border-neutral-855 dark:bg-charcoal-900/40 dark:text-warm-gray-350 dark:hover:text-white dark:hover:border-[#10b981]/30 transition-all duration-200 hover:-translate-y-0.5 cursor-pointer shadow-sm group"
                >
                  <span className="flex items-center gap-2.5">
                    <div className="p-1 bg-neutral-100 dark:bg-charcoal-800 rounded-lg group-hover:bg-neutral-250 dark:group-hover:bg-charcoal-700 transition-colors">
                      <Icon size={12} className="text-neutral-500 dark:text-[#10b981]" />
                    </div>
                    <span>{label}</span>
                  </span>
                  <ArrowRight size={12} className="text-neutral-400 group-hover:text-neutral-900 dark:group-hover:text-white transition-colors" />
                </button>
              ))}
            </div>
          </section>
        </div>

        {/* Right Side: Approval Inbox & Announcements */}
        <aside className="space-y-4 xl:col-span-4">
          
          {/* Approval Inbox Section */}
          <section className="premium-card p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <BellRing size={14} className="text-[#0ea971]" />
                <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">Approval Inbox</h3>
              </div>
              <span className="rounded-full bg-[#0ea971]/15 px-2 py-0.5 text-[9px] font-bold text-[#0ea971] dark:text-[#10b981] border border-[#0ea971]/20">{a.pendingLeaves.length}</span>
            </div>
            <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
              {a.pendingLeaves.slice(0, 4).map((l) => (
                <div key={l.id} className="flex gap-2.5 p-2.5 rounded-xl border border-neutral-200/60 dark:border-neutral-850 hover:border-neutral-350 dark:hover:border-neutral-800 transition-colors bg-white dark:bg-charcoal-900/10">
                  {/* Initials Avatar */}
                  <div className="w-8 h-8 rounded-lg bg-neutral-100 dark:bg-charcoal-800 text-neutral-800 dark:text-[#0ea971] flex items-center justify-center font-bold text-xs shrink-0 font-mono select-none">
                    {getInitials(l.employee?.full_name)}
                  </div>
                  
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <span className="block text-xs font-bold text-neutral-800 dark:text-warm-gray-100 truncate">{l.employee?.full_name || 'Employee'}</span>
                        <span className="block text-[10px] text-neutral-455 dark:text-neutral-500 mt-0.5">
                          {l.type} · {l.days} day{l.days > 1 ? 's' : ''}
                          {l.employee?.branch?.code && ` · ${l.employee.branch.code}`}
                        </span>
                      </div>
                      <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 bg-amber-500/10 text-amber-500 rounded border border-amber-500/20 leading-none mt-0.5">
                        Pending
                      </span>
                    </div>
                    {canApprove && (
                      <div className="mt-2.5 flex gap-2">
                        <button 
                          onClick={() => setLeaveStatus.mutate({ id: l.id, status: 'Approved' })} 
                          className="flex items-center gap-1 rounded-lg bg-emerald-600/90 hover:bg-emerald-600 px-2.5 py-1 text-[10px] font-bold text-white transition-colors cursor-pointer"
                        >
                          <Check size={10} /> Approve
                        </button>
                        <button 
                          onClick={() => setLeaveStatus.mutate({ id: l.id, status: 'Rejected' })} 
                          className="flex items-center gap-1 rounded-lg border border-neutral-300/80 px-2.5 py-1 text-[10px] font-semibold text-neutral-600 hover:bg-neutral-50 dark:border-neutral-800 dark:text-warm-gray-300 dark:hover:bg-charcoal-800 transition-colors cursor-pointer"
                        >
                          <Ban size={10} /> Decline
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {setLeaveStatus.isPending && <div className="flex justify-center py-2 text-[#0ea971]"><Loader2 size={14} className="animate-spin" /></div>}
              {a.pendingLeaves.length === 0 && <p className="py-4 text-center text-xs text-neutral-500">No pending approvals found.</p>}
            </div>
          </section>

          {/* Announcements Section */}
          <section className="premium-card p-4">
            <div className="mb-3 flex items-center gap-2">
              <Megaphone size={14} className="text-[#0ea971]" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">Announcements</h3>
            </div>
            <div className="space-y-4">
              <div className="p-2.5 bg-neutral-50/50 dark:bg-charcoal-900/30 rounded-xl border border-neutral-200/50 dark:border-neutral-800/80">
                <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 bg-[#0ea971]/15 text-[#0ea971] dark:text-[#10b981] rounded">
                  System Notice
                </span>
                <p className="mt-2 text-xs font-bold text-neutral-800 dark:text-neutral-100">Access is now scoped by role</p>
                <p className="mt-1 text-[10.5px] leading-relaxed text-neutral-550 dark:text-neutral-400">
                  Each branch/department HR sees only their people. Manage roles in Administration → Users &amp; Access.
                </p>
              </div>
            </div>
          </section>

        </aside>
      </div>

    </div>
  );
}
