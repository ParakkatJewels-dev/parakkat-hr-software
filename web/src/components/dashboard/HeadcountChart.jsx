// Split out of orgWidgets so recharts (~95 KB gzip, ~30% of the bundle) is lazy-loaded. Only the
// HR / entity-admin / super-admin presets render it; ESS users never download it.
import React from 'react';
import { BarChart3 } from 'lucide-react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip } from 'recharts';
import { useEmployees } from '../../data/employees';
import { Widget, EmptyNote, BRAND_GREEN, axis, chartTooltip } from './shared';

/** Headcount bar chart, grouped by branch (HR/entity) or entity (super admin). */
export default function HeadcountChart({ groupBy = 'branch', onNavigate }) {
  const { data: employees = [] } = useEmployees();
  const data = Object.entries(
    employees.reduce((m, e) => {
      if (e.status !== 'Active') return m; // every other tile counts Active only
      const k = (groupBy === 'entity' ? e.entity?.code : e.branch?.code) || '—';
      m[k] = (m[k] || 0) + 1;
      return m;
    }, {})
  )
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 9);

  return (
    <Widget
      title={`Headcount by ${groupBy === 'entity' ? 'Entity' : 'Branch'}`}
      icon={BarChart3}
      action="Directory"
      onAction={() => onNavigate?.('directory')}
    >
      {data.length === 0 ? (
        <EmptyNote>No employees visible.</EmptyNote>
      ) : (
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 6, left: -24, bottom: 4 }}>
              <defs>
                <linearGradient id="dashBarGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={BRAND_GREEN} stopOpacity={0.95} />
                  <stop offset="100%" stopColor={BRAND_GREEN} stopOpacity={0.15} />
                </linearGradient>
              </defs>
              <XAxis dataKey="name" {...axis} />
              <YAxis {...axis} allowDecimals={false} />
              <Tooltip {...chartTooltip} cursor={{ fill: 'rgba(16,185,129,0.03)' }} />
              <Bar dataKey="count" fill="url(#dashBarGradient)" radius={[4, 4, 0, 0]} maxBarSize={36} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </Widget>
  );
}
