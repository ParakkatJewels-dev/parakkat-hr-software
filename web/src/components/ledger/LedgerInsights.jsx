// Insights: the last six months at a glance. Loaded on demand (it brings the chart library), read-only.
import React, { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useAuth } from '../../auth/AuthContext';
import { useEmployees } from '../../data/employees';
import { useWorkInsights } from '../../data/work';
import { formatMinutes } from '../../lib/ledger/documents.js';
import { Message, dateLabel, money, useLedger } from './ui';
import { CheckCircle2, Clock, FolderOpen, LifeBuoy } from 'lucide-react';
import { StatCard, StatRow } from '../ui/StatCard';

import SearchSelect from '../ui/SearchSelect';
const axis = { stroke: 'var(--surface-text-soft)', fontSize: 12, tickLine: false };
const tooltip = { contentStyle: { background: 'var(--surface-elevated)', border: '1px solid var(--surface-border)', borderRadius: 4, fontSize: 13 },
  cursor: { fill: 'var(--surface-muted)' } };

function Chart({ title, note, data, bars, format }) {
  return (
    <section className="ledger-insight" aria-label={title}>
      <h3>{title}</h3>
      {note && <p className="ledger-quiet">{note}</p>}
      <div className="ledger-chart">
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--surface-border)" />
            <XAxis dataKey="label" {...axis} />
            <YAxis allowDecimals={false} {...axis} tickFormatter={format} width={format ? 64 : 40} />
            <Tooltip {...tooltip} formatter={format ? (value) => format(value) : undefined} />
            {bars.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} formatter={(value) => <span style={{ color: 'var(--surface-text-soft)' }}>{value}</span>} />}
            {bars.map(([key, name, colour]) => <Bar key={key} dataKey={key} name={name} fill={colour} radius={[6, 6, 0, 0]} maxBarSize={36} />)}
          </BarChart>
        </ResponsiveContainer>
      </div>
      {/* The same numbers as text, for screen readers and for copying. */}
      <table className="sr-only"><caption>{title}</caption><thead><tr><th>Month</th>{bars.map(([key, name]) => <th key={key}>{name}</th>)}</tr></thead>
        <tbody>{data.map((row) => <tr key={row.label}><td>{row.label}</td>{bars.map(([key]) => <td key={key}>{format ? format(row[key]) : row[key]}</td>)}</tr>)}</tbody></table>
    </section>
  );
}

function SmallTable({ title, head, rows, empty = 'Nothing yet.' }) {
  return (
    <section className="ledger-insight" aria-label={title}>
      <h3>{title}</h3>
      {rows.length ? (
        <table className="ledger-table"><thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, i) => <td key={i}>{cell}</td>)}</tr>)}</tbody></table>
      ) : <p className="ledger-quiet">{empty}</p>}
    </section>
  );
}

export default function LedgerInsights() {
  const { canTeam, creative } = useLedger();
  const { employee } = useAuth();
  const employeesQuery = useEmployees();
  const [person, setPerson] = useState('');
  const people = useMemo(() => (employeesQuery.data ?? []).filter((e) => e.id !== employee?.id)
    .sort((a, b) => (a.full_name ?? '').localeCompare(b.full_name ?? '')), [employeesQuery.data, employee?.id]);
  const insights = useWorkInsights(person || null);
  const picker = canTeam && people.length > 0 && (
    <div className="ledger-pickers"><label>Insights for <SearchSelect value={person} onChange={(e) => setPerson(e.target.value)}>
      <option value="">Me</option>{people.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</SearchSelect></label></div>);
  if (insights.isLoading) return <>{picker}<p className="ledger-quiet">Working out the last six months…</p></>;
  if (insights.error) return <>{picker}<Message error={insights.error} /></>;
  const data = insights.data;
  const months = data.months.map((m) => ({ ...m, on_time_rate: m.with_deadline ? Math.round((m.on_time / m.with_deadline) * 100) : null }));
  const withDeadline = months.reduce((sum, m) => sum + m.with_deadline, 0);
  const onTime = months.reduce((sum, m) => sum + m.on_time, 0);
  const delivered = months.reduce((sum, m) => sum + m.delivered, 0);
  const helpMinutes = months.reduce((sum, m) => sum + m.support_minutes, 0);
  const openNow = data.open_by_status.reduce((sum, row) => sum + row.count, 0);
  return (
    <div className="ledger-insights">
      {picker}
      <StatRow label="Six months at a glance">
        <StatCard label="Delivered" value={delivered} sub="Last six months" icon={CheckCircle2} tone="green" />
        <StatCard label="On time" value={withDeadline ? `${Math.round((onTime / withDeadline) * 100)}%` : '—'} sub={withDeadline ? `of ${withDeadline} with a deadline` : 'No deadlines set'} icon={Clock} tone="blue" />
        <StatCard label="Help given" value={formatMinutes(helpMinutes) || '0m'} sub={`${months.reduce((sum, m) => sum + m.support, 0)} entries`} icon={LifeBuoy} tone="violet" />
        <StatCard label="Open now" value={openNow} sub={data.ageing.older ? `${data.ageing.older} over 90 days` : 'None over 90 days'} icon={FolderOpen} tone="coral" />
      </StatRow>
      <p className="ledger-quiet">{dateLabel(data.from)} to {dateLabel(data.to)}. On time overall: {withDeadline ? `${Math.round((onTime / withDeadline) * 100)}% of ${withDeadline} tasks with a deadline` : 'no deadlines set'}
        {data.average_revisions != null ? ` · ${data.average_revisions} revisions per delivered task on average` : ''}.</p>
      <div className="ledger-insight-grid">
        <Chart title="Delivered per month" data={months} bars={[['delivered', 'Delivered', '#10b96a']]} />
        <Chart title="On time" note="Delivered on or before the deadline, among tasks that had one." data={months.map((m) => ({ ...m, on_time_rate: m.on_time_rate ?? 0 }))}
          bars={[['on_time_rate', 'On time', '#3b82f6']]} format={(v) => `${v}%`} />
        {creative && <Chart title="Spend: estimate and actual" data={months} bars={[['est', 'Estimate', 'var(--surface-border-strong)'], ['actual', 'Actual', 'var(--accent)']]} format={money} />}
        <Chart title="Help given per month" note={`${formatMinutes(months.reduce((sum, m) => sum + m.support_minutes, 0))} in total.`} data={months}
          bars={[['support', 'Help entries', '#8b5cf6']]} />
      </div>
      <div className="ledger-insight-grid">
        {creative && <SmallTable title="Delivered by brand" head={['Brand', 'Delivered']} rows={data.by_brand.map((b) => [b.brand, b.delivered])} />}
        <SmallTable title="Average turnaround by type" head={['Type', 'Days', 'Tasks']} rows={data.turnaround_by_type.map((t) => [t.type, t.days, t.count])} />
        <SmallTable title="Open tasks by status" head={['Status', 'Tasks']} rows={data.open_by_status.map((s) => [s.status, s.count])} empty="Nothing open." />
        <SmallTable title="How old open tasks are" head={['Age', 'Tasks']} rows={[['Up to a week', data.ageing.week], ['8–30 days', data.ageing.month],
          ['31–90 days', data.ageing.quarter], ['Over 90 days', data.ageing.older]]} />
        {creative && <SmallTable title="Vendors used" head={['Vendor', 'Tasks', 'Spend', 'Last']} rows={data.vendors.map((v) => [v.vendor, v.tasks, v.spend ? money(v.spend) : '—', dateLabel(v.last)])}
          empty="No vendors named on tasks in this period." />}
      </div>
    </div>
  );
}
