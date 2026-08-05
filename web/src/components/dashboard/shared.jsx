// Shared building blocks for the role-based dashboards.
// Every widget is permission-gated where it renders; these primitives are purely presentational
// plus the two cross-role widgets (notifications strip, holidays & anniversaries).
import React from 'react';
import { ArrowRight, BellRing, CalendarHeart, PartyPopper } from 'lucide-react';
import { useNotifications } from '../../data/notifications';
import { useHolidays } from '../../data/holidays';
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
    borderRadius: '12px',
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

const chartSeeds = {
  green: [20, 32, 28, 45, 38, 58, 54, 72],
  blue: [34, 28, 40, 36, 52, 48, 64, 60],
  violet: [24, 38, 34, 50, 42, 62, 56, 70],
  amber: [46, 34, 42, 30, 48, 38, 54, 44],
  orange: [38, 52, 44, 58, 46, 64, 54, 68],
  red: [58, 46, 62, 50, 66, 54, 70, 60],
};

function MiniChart({ tone }) {
  const values = chartSeeds[tone] || chartSeeds.green;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const coords = values.map((v, i) => {
    const x = 4 + i * 12;
    const y = 36 - ((v - min) / range) * 24;
    return { x, y };
  });
  const line = coords
    .map((p, i) => {
      if (i === 0) return `M ${p.x} ${p.y}`;
      const prev = coords[i - 1];
      const cx = (prev.x + p.x) / 2;
      return `C ${cx} ${prev.y}, ${cx} ${p.y}, ${p.x} ${p.y}`;
    })
    .join(' ');
  const area = `${line} L ${coords.at(-1).x} 40 L ${coords[0].x} 40 Z`;
  const last = coords.at(-1);

  return (
    <svg className="dashboard-mini-chart" viewBox="0 0 92 44" aria-hidden="true" focusable="false">
      <path className="dashboard-mini-chart-grid" d="M4 32 H88" />
      <path className="dashboard-mini-chart-area" d={area} />
      <path className="dashboard-mini-chart-line" d={line} />
      <circle className="dashboard-mini-chart-dot" cx={last.x} cy={last.y} r="2.25" />
    </svg>
  );
}

/** Standard widget card shell: title row with icon, optional count badge and "view" action. */
export function Widget({ title, icon: Icon, badge, action, onAction, children, className = '' }) {
  return (
    <section className={`premium-card dashboard-widget ${className}`}>
      <div className="mobile-list-row dashboard-widget-head mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {Icon && (
            <span className="dashboard-widget-icon">
              <Icon size={14} />
            </span>
          )}
          <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 truncate">
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
            onClick={onAction}
            className="dashboard-widget-action"
          >
            {action} <ArrowRight size={10} />
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

/** KPI tile. Renders as a button when `tab` is set, so the number is a way into the detail. */
export function KpiCard({ label, value, icon: Icon, badgeClass, subtext, tab, onNavigate }) {
  const clickable = Boolean(tab && onNavigate);
  const Tag = clickable ? 'button' : 'article';
  const tone = inferTone(badgeClass);
  return (
    <Tag
      {...(clickable ? { onClick: () => onNavigate(tab), type: 'button', title: `Open ${label}` } : {})}
      data-tone={tone}
      className={`premium-card dashboard-kpi text-left w-full ${clickable ? 'cursor-pointer' : ''}`}
    >
      <div className="mobile-list-row flex items-start justify-between gap-2">
        <span className="dashboard-kpi-label">{label}</span>
        <div className={`dashboard-kpi-icon ${badgeClass}`}>
          <Icon size={12} />
        </div>
      </div>
      <div className="dashboard-kpi-body">
        <p>{value}</p>
        {subtext && (
          <span>
            {subtext}
          </span>
        )}
      </div>
      <MiniChart tone={tone} />
    </Tag>
  );
}

// Tailwind needs literal class names, so pick the xl column count from a static map.
const KPI_COLS = { 3: 'xl:grid-cols-3', 4: 'xl:grid-cols-4', 5: 'xl:grid-cols-5', 6: 'xl:grid-cols-6' };

export function KpiRow({ kpis, onNavigate }) {
  const items = kpis.filter(Boolean);
  const cols = KPI_COLS[Math.min(Math.max(items.length, 3), 6)];
  return (
    <section className={`dashboard-kpi-row grid grid-cols-2 sm:grid-cols-3 gap-3 ${cols}`}>
      {items.map((k) => (
        <KpiCard key={k.label} {...k} onNavigate={onNavigate} />
      ))}
    </section>
  );
}

export function EmptyNote({ children }) {
  return <p className="py-4 text-center text-xs text-neutral-500">{children}</p>;
}

export function Avatar({ name }) {
  return (
    <div className="dashboard-avatar w-8 h-8 rounded-lg bg-neutral-100 dark:bg-charcoal-800 text-neutral-800 dark:text-[#0ea971] flex items-center justify-center font-bold text-xs shrink-0 font-mono select-none">
      {getInitials(name)}
    </div>
  );
}

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

export const STATUS_BADGE = {
  Pending: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
  Approved: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
  Rejected: 'bg-rose-500/10 text-rose-500 border-rose-500/20',
  Open: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
  'In Progress': 'bg-violet-500/10 text-violet-500 border-violet-500/20',
  Resolved: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
  Paid: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
};

export function StatusBadge({ status }) {
  return (
    <span
      className={`text-2xs font-mono font-bold px-1.5 py-0.5 rounded border leading-none shrink-0 ${
        STATUS_BADGE[status] || 'bg-neutral-500/10 text-neutral-500 border-neutral-500/20'
      }`}
    >
      {status}
    </span>
  );
}

/** Unread-notification strip shown on every dashboard, right under the greeting. */
export function NotificationsStrip({ onNavigate }) {
  const { data: notifications = [] } = useNotifications();
  const unread = notifications.filter((n) => !n.read_at).slice(0, 3);
  if (unread.length === 0) return null;

  return (
    <section className="premium-card dashboard-alert-strip border-amber-500/25 dark:border-amber-500/20">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400 shrink-0">
          <BellRing size={12} /> Needs attention
        </span>
        {unread.map((n) => (
          <button
            key={n.id}
            onClick={() => n.tab && onNavigate?.(n.tab)}
            className="flex items-center gap-1.5 rounded-lg border border-neutral-200/70 dark:border-neutral-850 bg-neutral-50/60 dark:bg-charcoal-900/40 px-2.5 py-1 text-base font-semibold text-neutral-700 dark:text-warm-gray-300 hover:border-amber-500/40 transition-colors cursor-pointer max-w-full"
          >
            <span className="truncate">{n.title}</span>
            <ArrowRight size={10} className="shrink-0 text-neutral-400" />
          </button>
        ))}
      </div>
    </section>
  );
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

  return (
    <Widget title="Holidays & Celebrations" icon={CalendarHeart} action={onNavigate ? "Calendar" : null} onAction={() => onNavigate?.('leave')}>
      <div className="space-y-1.5">
        {upcoming.map((h) => (
          <div
            key={h.id}
            className="mobile-list-row flex items-center justify-between rounded-lg border border-neutral-200/60 dark:border-neutral-850 px-2.5 py-1.5"
          >
            <span className="text-base font-semibold text-neutral-700 dark:text-warm-gray-200 truncate">
              {h.name}
              {h.is_optional && <span className="ml-1.5 text-2xs text-neutral-400">(optional)</span>}
            </span>
            <span className="text-2xs font-mono font-bold text-neutral-500 dark:text-neutral-400 shrink-0">
              {fmtDay(h.holiday_date)}
            </span>
          </div>
        ))}
        {anniversaries.slice(0, 4).map((e) => (
          <div
            key={e.id}
            className="mobile-list-row flex items-center justify-between rounded-lg border border-neutral-200/60 dark:border-neutral-850 px-2.5 py-1.5"
          >
            <span className="flex items-center gap-1.5 text-base font-semibold text-neutral-700 dark:text-warm-gray-200 truncate">
              <PartyPopper size={11} className="text-[#0ea971] shrink-0" />
              <span className="truncate">{e.full_name}</span>
            </span>
            <span className="text-2xs font-bold text-neutral-500 dark:text-neutral-400 shrink-0">
              {e.years} yr{e.years > 1 ? 's' : ''} · {e.inDays === 0 ? 'today' : `in ${e.inDays}d`}
            </span>
          </div>
        ))}
      </div>
    </Widget>
  );
}

/** Quick-action button grid, same look as the original dashboard. */
export function QuickActions({ actions, onNavigate }) {
  const items = actions.filter(Boolean).slice(0, 8);
  if (items.length === 0) return null;
  return (
    <section className="premium-card dashboard-quick-actions">
      <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
        Quick Actions
      </h3>
      <div className="quick-actions-grid grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        {items.map(({ label, tab, icon: Icon }) => (
          <button
            key={label}
            onClick={() => onNavigate?.(tab)}
            className="mobile-list-row dashboard-action-tile flex items-center justify-between rounded-xl border border-neutral-200/80 bg-neutral-50/50 px-3.5 py-2.5 text-left text-xs font-semibold text-neutral-700 hover:text-neutral-900 hover:border-neutral-355 dark:border-neutral-855 dark:bg-charcoal-900/40 dark:text-warm-gray-350 dark:hover:text-white dark:hover:border-[#10b981]/30 transition-all duration-200 hover:-translate-y-0.5 cursor-pointer shadow-sm group"
          >
            <span className="flex items-center gap-2.5">
              <div className="dashboard-action-icon p-1 bg-neutral-100 dark:bg-charcoal-800 rounded-lg group-hover:bg-neutral-250 dark:group-hover:bg-charcoal-700 transition-colors">
                <Icon size={12} className="text-neutral-500 dark:text-[#10b981]" />
              </div>
              <span>{label}</span>
            </span>
            <ArrowRight size={12} className="text-neutral-400 group-hover:text-neutral-900 dark:group-hover:text-white transition-colors" />
          </button>
        ))}
      </div>
    </section>
  );
}
