// A number card (2026 redesign): a pastel icon tile, a label, the figure, and an optional line under
// it. Becomes a button when it filters or opens something, so the figure is a way in.
//
// StatRow lays a set of them out: as many across as fit on a wide screen, two to a row on a phone.
import React from 'react';
import { Skeleton } from './Skeleton';
import './statCard.css';

export function StatCard({
  icon: Icon, tone = 'green', label, value, sub, subTone, onClick, active = false, loading = false,
  title, className = '', ariaLabel,
}) {
  const Tag = onClick ? 'button' : 'article';
  return (
    <Tag
      {...(onClick ? { type: 'button', onClick, 'aria-pressed': active || undefined, title, 'aria-label': ariaLabel } : {})}
      className={`stat-card ${onClick ? 'is-clickable' : ''} ${active ? 'is-active' : ''} ${className}`}
      data-tone={tone}
    >
      {Icon && <span className="stat-card-icon" aria-hidden="true"><Icon size={22} strokeWidth={1.9} /></span>}
      <span className="stat-card-copy">
        <span className="stat-card-label">{label}</span>
        {loading
          ? <Skeleton className="stat-card-skeleton" />
          : <span className="stat-card-value">{value}</span>}
        {sub != null && sub !== '' && <span className="stat-card-sub" data-tone={subTone}>{sub}</span>}
      </span>
    </Tag>
  );
}

export function StatRow({ children, className = '', label }) {
  // The count lets the CSS keep rows even (six cards: six, three or two across, never five and one).
  const count = React.Children.toArray(children).filter(Boolean).length;
  return (
    <section className={`stat-row ${className}`} aria-label={label} data-count={count}>
      {children}
    </section>
  );
}
