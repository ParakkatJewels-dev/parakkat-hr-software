// Shared building blocks for the role-based dashboards.
// Every widget is permission-gated where it renders; these primitives are purely presentational
// plus the shared holidays & anniversaries widget.
import React from 'react';
import { ArrowRight, CalendarDays, PartyPopper } from 'lucide-react';
import { useHolidays } from '../../data/holidays';
import { StatCard, StatRow } from '../ui/StatCard';
import StatusPill from '../ui/StatusPill';
import { useEmployees } from '../../data/employees';
import { todayIso } from '../../data/attendance';

export const BRAND_GREEN = '#0ea971';
export const PIE = ['#0ea971', '#10b981', '#34d399', '#6b8f89', '#a2d6c9'];
export const axis = { stroke: '#888888', fontSize: 9, tickLine: false, axisLine: false };

export const chartTooltip = {
  contentStyle: {
    background: 'rgba(17, 26, 22, 0.95)',
    backdropFilter: 'blur(8px)',
    border: '1px solid rgba(16, 185, 129, 0.2)',
    borderRadius: '4px',
    color: '#e6f0eb',
    fontSize: '11px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
  },
  itemStyle: { color: '#e6f0eb' },
};

export const getInitials = (name) =>
  (name || 'E').split(' ').filter(Boolean).slice(0, 2).map((s) => s[0]).join('').toUpperCase();

/** '2026-07-25' -> '25 Jul' (IST-safe: date-only strings are parsed as calendar dates). */
export const fmtDay = (iso) => {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
};

export const relTime = (iso) => {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
};

export const inr = (n) =>
  `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

const inferTone = (className = '') => {
  if (className.includes('rose')) return 'red';
  if (className.includes('amber')) return 'amber';
  if (className.includes('orange')) return 'orange';
  if (className.includes('blue')) return 'blue';
  if (className.includes('violet') || className.includes('purple')) return 'violet';
  return 'green';
};

/** Standard widget card shell: title row with icon, optional count badge and "view" action. */
export function Widget({ title, icon: Icon, badge, action, onAction, children, className = '' }) {
  const actionable = Boolean(action && onAction);
  const openFromCard = (event) => {
    if (!actionable) return;
    const interactive = event.target.closest('button, a, input, select, textarea, [role="button"]');
    if (interactive) return;
    onAction();
  };

  return (
    <section
      onClick={openFromCard}
      className={`premium-card dashboard-widget ${actionable ? 'dashboard-widget-clickable' : ''} ${className}`}
    >
      <div className="mobile-list-row dashboard-widget-head flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {Icon && <Icon size={17} className="dashboard-widget-title-icon" aria-hidden="true" />}
          <h3 className="dashboard-widget-title">
            {title}
          </h3>
          {badge != null && (
            <span className="dashboard-badge">
              {badge}
            </span>
          )}
        </div>
        {action && (
          <button
            type="button"
            onClick={onAction}
            className="dashboard-widget-action"
          >
            {action} <ArrowRight size={14} />
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

// Tailwind-era tones on the KPI definitions, mapped onto the redesign's StatCard tones.
const STAT_TONE = { red: 'red', amber: 'amber', orange: 'coral', blue: 'blue', violet: 'violet', green: 'green' };

/** KPI tile. Renders as a button when `tab` is set, so the number is a way into the detail. */
export function KpiCard({ label, value, icon, badgeClass, subtext, tab, onNavigate }) {
  const clickable = Boolean(tab && onNavigate);
  return (
    <StatCard
      label={label}
      value={value}
      sub={subtext}
      icon={icon}
      tone={STAT_TONE[inferTone(badgeClass)] ?? 'green'}
      onClick={clickable ? () => onNavigate(tab) : undefined}
      title={clickable ? `Open ${label}` : undefined}
    />
  );
}

export function KpiRow({ kpis, onNavigate }) {
  const items = kpis.filter(Boolean);
  return (
    <StatRow label="Key figures">
      {items.map((k) => (
        <KpiCard key={k.label} {...k} onNavigate={onNavigate} />
      ))}
    </StatRow>
  );
}

export function EmptyNote({ children }) {
  return <p className="py-4 text-center text-xs text-neutral-500">{children}</p>;
}

// One definition, in ui/Avatar.jsx — this used to be a second one at a different size and
// colour, so the same person looked like two people depending on the screen.
export { default as Avatar } from '../ui/Avatar';


/** Small labelled count used inside widgets ("Late 4", "Absent 2", …). */
export function StatPill({ label, value, tone = 'neutral', onClick }) {
  const tones = {
    neutral: 'bg-neutral-100 text-neutral-600 dark:bg-charcoal-800 dark:text-warm-gray-300',
    green: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    amber: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    red: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
    blue: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
    violet: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
  };
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      {...(onClick ? { onClick, type: 'button', title: `Open ${label}` } : {})}
      data-tone={tone}
      className={`mobile-list-row dashboard-stat-pill flex items-center justify-between rounded-lg px-2.5 py-1.5 w-full ${tones[tone]} ${
        onClick ? 'cursor-pointer hover:brightness-110 transition-all' : ''
      }`}
    >
      <span className="text-2xs font-semibold">{label}</span>
      <span className="text-xs font-bold font-mono">{value}</span>
    </Tag>
  );
}

/** A request or record status, as the shared pill (green done, amber waiting, red refused…). */
export function StatusBadge({ status }) {
  return <StatusPill status={status} className="shrink-0" />;
}

/** Upcoming holidays for everyone; work anniversaries only when the viewer can see other people. */
export function HolidaysCard({ showAnniversaries, onNavigate }) {
  const today = todayIso();
  const year = Number(today.slice(0, 4));
  const { data: holidays = [] } = useHolidays(null, year);
  // Only ESS-visible data is needed when anniversaries are hidden; skip the extra query.
  const { data: employees = [] } = useEmployees({ enabled: Boolean(showAnniversaries) });

  const upcoming = holidays.filter((h) => h.holiday_date >= today).slice(0, 4);

  // Work anniversaries in the next 14 days, matched on month-day so the year doesn't matter.
  const anniversaries = [];
  if (showAnniversaries) {
    const windowDays = [...Array(14)].map((_, i) => {
      const d = new Date(`${today}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + i);
      return d.toISOString().slice(5, 10); // 'MM-DD'
    });
    for (const e of employees) {
      if (!e.join_date || e.status !== 'Active') continue;
      const md = e.join_date.slice(5, 10);
      const idx = windowDays.indexOf(md);
      const years = year - Number(e.join_date.slice(0, 4));
      if (idx >= 0 && years > 0) anniversaries.push({ ...e, inDays: idx, years });
    }
    anniversaries.sort((a, b) => a.inDays - b.inDays);
  }

  if (upcoming.length === 0 && anniversaries.length === 0) return null;

  const longDay = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  return (
    <Widget title={showAnniversaries ? 'Holidays & celebrations' : 'Upcoming holidays'} action={onNavigate ? 'View all' : null} onAction={() => onNavigate?.('leave')}>
      <div className="home-mini-list">
        {upcoming.map((h) => (
          <div key={h.id} className="home-mini-row">
            <span className="home-mini-icon" aria-hidden="true"><CalendarDays size={17} /></span>
            <span className="home-mini-copy">
              <strong>{h.name}{h.is_optional && <em> · optional</em>}</strong>
              <span>{longDay(h.holiday_date)}</span>
            </span>
          </div>
        ))}
        {anniversaries.slice(0, 4).map((e) => (
          <div key={e.id} className="home-mini-row">
            <span className="home-mini-icon" data-tone="coral" aria-hidden="true"><PartyPopper size={17} /></span>
            <span className="home-mini-copy">
              <strong>{e.full_name}</strong>
              <span>{e.years} year{e.years > 1 ? 's' : ''} at work · {e.inDays === 0 ? 'today' : `in ${e.inDays} day${e.inDays > 1 ? 's' : ''}`}</span>
            </span>
          </div>
        ))}
      </div>
    </Widget>
  );
}

const ACTION_TONES = ['green', 'blue', 'violet', 'coral', 'amber', 'slate'];

/** Quick actions: tiles with a tinted icon, a name and a one-line hint (2026 redesign). */
export function QuickActions({ actions, onNavigate }) {
  const items = actions.filter(Boolean).slice(0, 6);
  if (items.length === 0) return null;
  return (
    <section className="premium-card dashboard-widget dashboard-quick-actions">
      <div className="dashboard-widget-head">
        <h3 className="dashboard-widget-title">Quick actions</h3>
      </div>
      <div className="quick-actions-grid">
        {items.map(({ label, hint, tab, icon: Icon }, index) => (
          <button key={label} type="button" onClick={() => onNavigate?.(tab)} className="quick-action-tile" data-tone={ACTION_TONES[index % ACTION_TONES.length]}>
            <span className="quick-action-icon" aria-hidden="true"><Icon size={19} /></span>
            <span className="quick-action-copy">
              <strong>{label}</strong>
              {hint && <span>{hint}</span>}
            </span>
            <ArrowRight size={16} className="quick-action-arrow" aria-hidden="true" />
          </button>
        ))}
      </div>
    </section>
  );
}
