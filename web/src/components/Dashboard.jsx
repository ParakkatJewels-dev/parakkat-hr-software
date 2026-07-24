import React, { useMemo } from 'react';
import {
  Users, Building2, CalendarDays, CheckSquare, ReceiptText, LifeBuoy, Network,
  ArrowRight, BellRing, Megaphone, Check, Ban, Loader2,
} from 'lucide-react';
import { Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useEmployees } from '../data/employees';
import { useLeaves, useSetLeaveStatus } from '../data/leaves';
import { useExpenses } from '../data/expenses';
import { useTickets } from '../data/tickets';
import { useOrg } from '../data/org';
import { useAuth } from '../auth/AuthContext';
import { usePermissions } from '../auth/usePermissions';

const chartTooltip = {
  contentStyle: { background: '#1a1a1a', border: '1px solid #3a3a3a', borderRadius: '10px', color: '#ececec', fontSize: '12px' },
  itemStyle: { color: '#ececec' },
};
const axis = { stroke: '#929292', fontSize: 10, tickLine: false, axisLine: false };
const GOLD = '#d9b45a';
const PIE = ['#d9b45a', '#6b8f89', '#a98b5d', '#8a8a8a', '#556b8a', '#b06a5a'];

export default function Dashboard({ onNavigate }) {
  const { data: employees = [] } = useEmployees();
  const { data: leaves = [] } = useLeaves();
  const { data: expenses = [] } = useExpenses();
  const { data: tickets = [] } = useTickets();
  const { data: org } = useOrg();
  const { employee } = useAuth();
  const { canAny } = usePermissions();
  const setLeaveStatus = useSetLeaveStatus();

  const canApprove = canAny('leave.approve');
  const greeting = (employee?.full_name || 'there').split(' ')[0];

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

  const kpis = [
    { label: 'Employees (in scope)', value: employees.length, icon: Users },
    { label: 'Branches', value: (org?.branches ?? []).length, icon: Building2 },
    { label: 'Entities', value: (org?.entities ?? []).length, icon: Network },
    { label: 'Pending leave', value: a.pendingLeaves.length, icon: CalendarDays },
    { label: 'Pending expenses', value: a.pendingExpenses.length, icon: ReceiptText },
    { label: 'Open tickets', value: a.openTickets, icon: LifeBuoy },
  ];

  const quickActions = [
    { label: 'Review leave', tab: 'leave', icon: CalendarDays },
    { label: 'Review expenses', tab: 'expense', icon: ReceiptText },
    { label: 'Directory', tab: 'directory', icon: Users },
    { label: 'Organization', tab: 'organization', icon: Network },
  ];

  return (
    <div className="page-shell space-y-5 animate-slide-up">
      <section className="premium-card p-5">
        <p className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">Good day, {greeting}</p>
        <p className="mt-1 text-xs text-neutral-500">Here's your people-operations snapshot — scoped to your access.</p>
      </section>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-6">
        {kpis.map(({ label, value, icon: Icon }) => (
          <article key={label} className="premium-card p-4">
            <div className="flex items-start justify-between gap-3">
              <span className="text-xs font-medium text-neutral-500">{label}</span>
              <Icon size={16} className="text-gold-500" />
            </div>
            <p className="mt-3 text-2xl font-semibold tracking-tight text-neutral-900 dark:text-white">{value}</p>
          </article>
        ))}
      </section>

      <div className="grid grid-cols-1 gap-5 2xl:grid-cols-12">
        <div className="space-y-5 2xl:col-span-8">
          <section className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <article className="premium-card p-5">
              <div className="mb-4"><h3 className="font-semibold text-neutral-900 dark:text-white">Headcount by entity</h3><p className="mt-1 text-xs text-neutral-500">Employees visible to you, per company</p></div>
              <div className="h-60">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={a.byEntity} margin={{ top: 8, right: 6, left: -24, bottom: 4 }}>
                    <XAxis dataKey="name" {...axis} /><YAxis {...axis} /><Tooltip {...chartTooltip} />
                    <Bar dataKey="count" fill={GOLD} radius={[5, 5, 0, 0]} maxBarSize={48} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </article>
            <article className="premium-card p-5">
              <div className="mb-4"><h3 className="font-semibold text-neutral-900 dark:text-white">Leave requests</h3><p className="mt-1 text-xs text-neutral-500">By status, within your scope</p></div>
              {a.leaveStatus.length === 0 ? (
                <div className="flex h-60 items-center justify-center text-xs text-neutral-400">No leave data yet.</div>
              ) : (
                <div className="flex h-60 items-center gap-3">
                  <div className="h-full min-w-0 flex-1">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart><Pie data={a.leaveStatus} dataKey="value" innerRadius={52} outerRadius={78} paddingAngle={3}>{a.leaveStatus.map((it, i) => <Cell key={it.name} fill={PIE[i % PIE.length]} />)}</Pie><Tooltip {...chartTooltip} /></PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="w-28 space-y-2">
                    {a.leaveStatus.map((it, i) => (
                      <div key={it.name} className="flex items-center gap-1.5 text-[11px] text-neutral-500"><span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: PIE[i % PIE.length] }} />{it.name} ({it.value})</div>
                    ))}
                  </div>
                </div>
              )}
            </article>
          </section>

          <section className="premium-card p-5">
            <div className="mb-4 flex items-center gap-2"><CheckSquare size={18} className="text-gold-500" /><h3 className="font-semibold text-neutral-900 dark:text-white">Quick actions</h3></div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {quickActions.map(({ label, tab, icon: Icon }) => (
                <button key={tab} onClick={() => onNavigate?.(tab)} className="flex items-center justify-between rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-left text-sm font-medium text-neutral-700 transition-colors hover:border-gold-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:border-gold-500 cursor-pointer">
                  <span className="flex items-center gap-2"><Icon size={16} className="text-gold-500" />{label}</span><ArrowRight size={16} />
                </button>
              ))}
            </div>
          </section>
        </div>

        <aside className="space-y-5 2xl:col-span-4">
          <section className="premium-card p-5">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2"><BellRing size={18} className="text-gold-500" /><h3 className="font-semibold text-neutral-900 dark:text-white">Approval inbox</h3></div>
              <span className="rounded-full bg-gold-500/15 px-2 py-0.5 text-xs font-semibold text-gold-600 dark:text-gold-400">{a.pendingLeaves.length}</span>
            </div>
            <div className="space-y-2">
              {a.pendingLeaves.slice(0, 4).map((l) => (
                <div key={l.id} className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-700">
                  <p className="text-sm font-medium text-neutral-800 dark:text-neutral-100">{l.employee?.full_name || 'Employee'}</p>
                  <p className="mt-1 text-xs text-neutral-500">{l.type} · {l.days} day{l.days > 1 ? 's' : ''}{l.employee?.branch?.code ? ` · ${l.employee.branch.code}` : ''}</p>
                  {canApprove && (
                    <div className="mt-3 flex gap-2">
                      <button onClick={() => setLeaveStatus.mutate({ id: l.id, status: 'Approved' })} className="flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 cursor-pointer"><Check size={12} /> Approve</button>
                      <button onClick={() => setLeaveStatus.mutate({ id: l.id, status: 'Rejected' })} className="flex items-center gap-1 rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs font-semibold text-neutral-600 hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800 cursor-pointer"><Ban size={12} /> Decline</button>
                    </div>
                  )}
                </div>
              ))}
              {setLeaveStatus.isPending && <div className="flex justify-center py-2 text-gold-500"><Loader2 size={16} className="animate-spin" /></div>}
              {a.pendingLeaves.length === 0 && <p className="py-3 text-center text-sm text-neutral-500">No pending approvals.</p>}
            </div>
          </section>

          <section className="premium-card p-5">
            <div className="mb-4 flex items-center gap-2"><Megaphone size={18} className="text-gold-500" /><h3 className="font-semibold text-neutral-900 dark:text-white">Announcements</h3></div>
            <div className="space-y-4">
              <div><span className="text-xs font-semibold text-gold-600 dark:text-gold-450">System</span><p className="mt-1 text-sm font-medium text-neutral-800 dark:text-neutral-100">Access is now scoped by role</p><p className="mt-1 text-xs leading-relaxed text-neutral-500">Each branch/department HR sees only their people. Manage roles in Administration → Users &amp; Access.</p></div>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
