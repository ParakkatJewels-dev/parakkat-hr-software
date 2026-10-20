// Insights: the last six months at a glance. Loaded on demand (it brings the chart library), read-only.
import React from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useLedgerInsights } from '../../data/workLedger';
import { formatMinutes } from '../../lib/ledger/documents.js';
import { Message, dateLabel, money, useLedger } from './ui';

const axis = { stroke: 'var(--ledger-ink-soft)', fontSize: 12, tickLine: false };
const tooltip = { contentStyle: { background: 'var(--ledger-paper)', border: '1px solid var(--ledger-rule)', borderRadius: 3, fontSize: 13 },
  cursor: { fill: 'var(--ledger-accent-wash)' } };

function Chart({ title, note, data, bars, format }) {
  return (
    <section className="ledger-insight" aria-label={title}>
      <h3>{title}</h3>
      {note && <p className="ledger-quiet">{note}</p>}
      <div className="ledger-chart">
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--ledger-rule)" />
            <XAxis dataKey="label" {...axis} />
            <YAxis allowDecimals={false} {...axis} tickFormatter={format} width={format ? 64 : 40} />
            <Tooltip {...tooltip} formatter={format ? (value) => format(value) : undefined} />
            {bars.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
            {bars.map(([key, name, colour]) => <Bar key={key} dataKey={key} name={name} fill={colour} radius={[2, 2, 0, 0]} maxBarSize={36} />)}
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
  const { owner } = useLedger();
  const insights = useLedgerInsights(owner);
  if (insights.isLoading) return <p className="ledger-quiet">Working out the last six months…</p>;
  if (insights.error) return <Message error={insights.error} />;
  const data = insights.data;
  const months = data.months.map((m) => ({ ...m, on_time_rate: m.with_deadline ? Math.round((m.on_time / m.with_deadline) * 100) : null }));
  const withDeadline = months.reduce((sum, m) => sum + m.with_deadline, 0);
  const onTime = months.reduce((sum, m) => sum + m.on_time, 0);
  return (
    <div className="ledger-insights">
      <p className="ledger-quiet">{dateLabel(data.from)} to {dateLabel(data.to)}. On time overall: {withDeadline ? `${Math.round((onTime / withDeadline) * 100)}% of ${withDeadline} tasks with a deadline` : 'no deadlines set'}
        {data.average_revisions != null ? ` · ${data.average_revisions} revisions per delivered task on average` : ''}.</p>
      <div className="ledger-insight-grid">
        <Chart title="Delivered per month" data={months} bars={[['delivered', 'Delivered', 'var(--ledger-accent)']]} />
        <Chart title="On time" note="Delivered on or before the deadline, among tasks that had one." data={months.map((m) => ({ ...m, on_time_rate: m.on_time_rate ?? 0 }))}
          bars={[['on_time_rate', 'On time', 'var(--ledger-good)']]} format={(v) => `${v}%`} />
        <Chart title="Spend: estimate and actual" data={months} bars={[['est', 'Estimate', 'var(--ledger-rule)'], ['actual', 'Actual', 'var(--ledger-accent)']]} format={money} />
        <Chart title="Help given per month" note={`${formatMinutes(months.reduce((sum, m) => sum + m.support_minutes, 0))} in total.`} data={months}
          bars={[['support', 'Help entries', 'var(--ledger-ink-soft)']]} />
      </div>
      <div className="ledger-insight-grid">
        <SmallTable title="Delivered by brand" head={['Brand', 'Delivered']} rows={data.by_brand.map((b) => [b.brand, b.delivered])} />
        <SmallTable title="Average turnaround by type" head={['Type', 'Days', 'Tasks']} rows={data.turnaround_by_type.map((t) => [t.type, t.days, t.count])} />
        <SmallTable title="Open tasks by status" head={['Status', 'Tasks']} rows={data.open_by_status.map((s) => [s.status, s.count])} empty="Nothing open." />
        <SmallTable title="How old open tasks are" head={['Age', 'Tasks']} rows={[['Up to a week', data.ageing.week], ['8–30 days', data.ageing.month],
          ['31–90 days', data.ageing.quarter], ['Over 90 days', data.ageing.older]]} />
        <SmallTable title="Vendors used" head={['Vendor', 'Tasks', 'Spend', 'Last']} rows={data.vendors.map((v) => [v.vendor, v.tasks, v.spend ? money(v.spend) : '—', dateLabel(v.last)])}
          empty="No vendors named on tasks in this period." />
      </div>
    </div>
  );
}
