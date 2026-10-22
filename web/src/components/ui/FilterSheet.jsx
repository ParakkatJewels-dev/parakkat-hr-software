// Filters on a phone (round 3). A filter card used to stack a date, a search box, three or four
// labelled dropdowns and a "More filters · Optional" bar above the list, so the first row of data
// sat a screen down. On a phone the search stays in view (PhoneSearch) and everything else moves
// behind one Filters button that says how many are on and opens a sheet from the bottom.
//
// The screen still lays its filters out inline on a computer; it renders this only on a phone and
// passes the same controls as children.
import React, { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import './filterSheet.css';

/** The search box a phone keeps above the list. */
export function PhoneSearch({ value, onChange, placeholder = 'Search…', label = 'Search', className = '' }) {
  return (
    <label className={`phone-search ${className}`}>
      <Search size={16} aria-hidden="true" />
      <input type="search" value={value} onChange={onChange} placeholder={placeholder} aria-label={label} autoComplete="off" />
    </label>
  );
}

/** A labelled control inside the sheet, for fields that are not already a FilterSelect. `group` is
 *  for a set of controls (a date range), which a <label> must not wrap. */
export function SheetField({ label, group = false, children }) {
  if (group) {
    return (
      <div className="filter-sheet-field" role="group" aria-label={label}>
        <span>{label}</span>
        {children}
      </div>
    );
  }
  return (
    <label className="filter-sheet-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

/** `foot={false}` drops Clear all / Show results, for a sheet of actions rather than filters. */
export default function FilterSheet({ count = 0, onClear, title = 'Filters', label = 'Filters', icon: Icon = SlidersHorizontal, iconOnly = false, foot = true, children }) {
  const [open, setOpen] = useState(false);
  const titleId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => { if (event.key === 'Escape' && !event.defaultPrevented) setOpen(false); };
    document.addEventListener('keydown', onKey);
    // The page underneath should not scroll while the sheet is up.
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = overflow; };
  }, [open]);

  return (
    <>
      <button type="button" className={`filter-sheet-button ${count ? 'is-on' : ''} ${iconOnly ? 'is-icon' : ''}`}
        aria-haspopup="dialog" aria-expanded={open}
        aria-label={count ? `${label}, ${count} on` : label} onClick={() => setOpen(true)}>
        <Icon size={16} aria-hidden="true" />
        {!iconOnly && <span>{label}</span>}
        {count > 0 && <span className="filter-sheet-count" aria-hidden="true">{count}</span>}
      </button>
      {open && createPortal(
        <div className="filter-sheet-layer">
          {/* A plain backdrop rather than a document click listener: dropdowns inside the sheet open
              their own layer outside it, and a tap there must not close the sheet. */}
          <button type="button" className="filter-sheet-backdrop" aria-label="Close filters" tabIndex={-1} onClick={() => setOpen(false)} />
          <div className="filter-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
            <div className="filter-sheet-head">
              <strong id={titleId}>{title}</strong>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close filters"><X size={18} /></button>
            </div>
            <div className={`filter-sheet-body ${foot ? '' : 'is-bare'}`}>{children}</div>
            {foot && (
              <div className="filter-sheet-foot">
                {onClear && <button type="button" className="filter-sheet-clear" disabled={!count} onClick={onClear}>Clear all</button>}
                <button type="button" className="filter-sheet-done" onClick={() => setOpen(false)}>Show results</button>
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
