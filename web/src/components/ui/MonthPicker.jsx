// A month field (round 3) in place of <input type="month">. The browser's own month calendar
// cannot be styled or sized — on a narrow window it opened a desktop popup wider than the screen,
// and Safari before 17 had no month picker at all. This is ‹ October 2026 › with a grid of months
// behind the middle: under the field on a computer, a sheet from the bottom on a phone.
//
// Drop-in: `value` is "YYYY-MM" and onChange gets an event-like `{ target: { value } }`, so callers
// that read `e.target.value` do not change. `clearable` adds a way back to no month ('' — "All
// months" on a filter).
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useMediaQuery } from '../../lib/useMediaQuery';
import './monthPicker.css';

const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const valid = (value) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value ?? '');
const pad = (n) => String(n).padStart(2, '0');

/** "2026-10" moved by `delta` months. */
export function shiftMonthValue(value, delta) {
  const [y, m] = value.split('-').map(Number);
  const index = y * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
}

/** "October 2026", or the placeholder for an empty / malformed value. */
export function monthLabel(value, placeholder = 'Choose a month') {
  if (!valid(value)) return placeholder;
  const [y, m] = value.split('-').map(Number);
  return `${LONG[m - 1]} ${y}`;
}

const inRange = (value, min, max) => (!min || value >= min) && (!max || value <= max);

export default function MonthPicker({
  value, onChange, min, max, disabled = false, required = false, placeholder, clearable = false, clearLabel = 'All months', className = '',
  'aria-label': ariaLabel = 'Month', id,
}) {
  const current = valid(value) ? value : '';
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(() => Number((current || thisMonth).slice(0, 4)));
  const [place, setPlace] = useState(null);
  const field = useRef(null);
  const panel = useRef(null);
  const phone = useMediaQuery('(max-width: 640px)');

  const emit = (next) => { if (next && inRange(next, min, max)) onChange?.({ target: { value: next } }); };
  const step = (delta) => emit(shiftMonthValue(current || thisMonth, delta));
  const openPanel = () => { if (disabled) return; setYear(Number((current || thisMonth).slice(0, 4))); setOpen(true); };
  const close = () => setOpen(false);

  useLayoutEffect(() => {
    if (!open || phone) return undefined;
    const measure = () => {
      const r = field.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(Math.max(r.width, 264), window.innerWidth - 16);
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      const up = window.innerHeight - r.bottom < 300 && r.top > window.innerHeight - r.bottom;
      setPlace(up ? { left, width, bottom: window.innerHeight - r.top + 4 } : { left, width, top: r.bottom + 4 });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => { window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [open, phone]);

  useEffect(() => {
    if (!open) return undefined;
    const outside = (event) => {
      if (!panel.current?.contains(event.target) && !field.current?.contains(event.target)) close();
    };
    const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
    document.addEventListener('mousedown', outside);
    document.addEventListener('touchstart', outside);
    document.addEventListener('keydown', onKey);
    (panel.current?.querySelector('[aria-pressed="true"]') ?? panel.current?.querySelector('.month-picker-cell'))?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('touchstart', outside);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const prevDisabled = disabled || (min && current && shiftMonthValue(current, -1) < min);
  const nextDisabled = disabled || (max && current && shiftMonthValue(current, 1) > max);
  return (
    <div ref={field} className={`month-picker ${disabled ? 'is-disabled' : ''} ${className}`}>
      <button type="button" className="month-picker-step" onClick={() => step(-1)} disabled={Boolean(prevDisabled)} aria-label="Previous month">
        <ChevronLeft size={16} aria-hidden="true" />
      </button>
      <button type="button" id={id} className="month-picker-value" onClick={() => (open ? close() : openPanel())} disabled={disabled}
        aria-haspopup="dialog" aria-expanded={open} aria-label={`${ariaLabel}: ${monthLabel(current, placeholder ?? (clearable ? clearLabel : undefined))}`}>
        <CalendarDays size={15} aria-hidden="true" />
        <span>{monthLabel(current, placeholder ?? (clearable ? clearLabel : undefined))}</span>
      </button>
      <button type="button" className="month-picker-step" onClick={() => step(1)} disabled={Boolean(nextDisabled)} aria-label="Next month">
        <ChevronRight size={16} aria-hidden="true" />
      </button>
      {/* Keeps `required` in the browser's own form check and the value in the form. */}
      <input className="month-picker-native" tabIndex={-1} aria-hidden="true" aria-label={ariaLabel} value={current} required={required} readOnly
        onFocus={() => field.current?.querySelector('.month-picker-value')?.focus()} />
      {open && createPortal(
        <div className={`month-picker-layer ${phone ? 'is-sheet' : ''}`}>
          {phone && <div className="month-picker-backdrop" aria-hidden="true" onClick={close} />}
          <div ref={panel} role="dialog" aria-label={ariaLabel} className="month-picker-panel"
            style={phone ? undefined : place ?? { visibility: 'hidden' }}>
            {phone && (
              <div className="month-picker-head">
                <strong>{ariaLabel}</strong>
                <button type="button" onClick={close} aria-label="Close"><X size={18} /></button>
              </div>
            )}
            <div className="month-picker-year">
              <button type="button" onClick={() => setYear((y) => y - 1)} aria-label="Previous year"
                disabled={Boolean(min && `${year - 1}-12` < min)}><ChevronLeft size={16} /></button>
              <strong aria-live="polite">{year}</strong>
              <button type="button" onClick={() => setYear((y) => y + 1)} aria-label="Next year"
                disabled={Boolean(max && `${year + 1}-01` > max)}><ChevronRight size={16} /></button>
            </div>
            <div className="month-picker-grid">
              {SHORT.map((label, i) => {
                const v = `${year}-${pad(i + 1)}`;
                return (
                  <button key={v} type="button" className="month-picker-cell" aria-pressed={v === current}
                    data-now={v === thisMonth || undefined} disabled={!inRange(v, min, max)} aria-label={`${LONG[i]} ${year}`}
                    onClick={() => { emit(v); close(); }}>
                    {label}
                  </button>
                );
              })}
            </div>
            <div className="month-picker-foot">
              {clearable && current && (
                <button type="button" className="month-picker-today" onClick={() => { onChange?.({ target: { value: '' } }); close(); }}>{clearLabel}</button>
              )}
              {inRange(thisMonth, min, max) && thisMonth !== current && (
                <button type="button" className="month-picker-today" onClick={() => { emit(thisMonth); close(); }}>This month</button>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
