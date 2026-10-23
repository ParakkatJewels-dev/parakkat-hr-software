// Search screens and actions (round 3) - the top bar's search, on Ctrl+K / ⌘K and the phone's
// magnifier. It was an inline tray of twelve fixed commands under the header: the same list for
// everybody (an employee was offered Run Payroll), a "Close (ESC)" bar a phone cannot press Escape
// for, and the page still showing and scrolling underneath.
//
// Now: the screens this person can actually open (from the same tree as the sidebar) plus a few
// quick actions, matched on every word typed. A phone gets a full-screen page with a back arrow;
// a computer a panel over a dimmed page. It closes on the back arrow, Escape, a tap outside, a
// choice, or a change of page.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ChevronRight, CornerDownLeft, Search, X } from 'lucide-react';
import { useMediaQuery } from '../../lib/useMediaQuery';
import './searchPanel.css';

const norm = (text) => String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Every word typed must appear somewhere in the item's label, its section or its keywords. */
export function matchesQuery(item, query) {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = norm(`${item.label} ${item.hint ?? ''} ${item.keywords ?? ''}`);
  return words.every((word) => hay.includes(word));
}

export default function SearchPanel({ open, onClose, screens = [], actions = [], currentId }) {
  const phone = useMediaQuery('(max-width: 640px)');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef(null);
  const list = useRef(null);

  const groups = useMemo(() => {
    const shownActions = actions.filter((item) => matchesQuery(item, query));
    const shownScreens = screens.filter((item) => matchesQuery(item, query));
    return [
      shownActions.length ? { title: 'Quick actions', items: shownActions } : null,
      shownScreens.length ? { title: query.trim() ? 'Screens' : 'Go to', items: shownScreens } : null,
    ].filter(Boolean);
  }, [actions, screens, query]);
  const flat = groups.flatMap((group) => group.items);

  useEffect(() => {
    if (!open) return undefined;
    setQuery('');
    setActive(0);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    // After the panel is painted, so the phone keyboard opens on the field.
    const timer = setTimeout(() => input.current?.focus({ preventScroll: true }), 30);
    return () => { clearTimeout(timer); document.body.style.overflow = overflow; };
  }, [open]);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const choose = (item) => { if (!item) return; onClose(); item.run(); };
  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((i) => Math.min(i + 1, flat.length - 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (event.key === 'Enter') { event.preventDefault(); choose(flat[active]); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
  };

  let index = -1;
  return createPortal(
    <div className={`search-panel-layer ${phone ? 'is-phone' : ''}`}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="search-panel" role="dialog" aria-modal="true" aria-label="Search screens and actions" onKeyDown={onKeyDown}>
        <div className="search-panel-bar">
          {phone && (
            <button type="button" className="search-panel-back" onClick={onClose} aria-label="Close search">
              <ArrowLeft size={20} aria-hidden="true" />
            </button>
          )}
          <label className="search-panel-field">
            <Search size={18} aria-hidden="true" />
            <input ref={input} type="search" value={query} onChange={(event) => setQuery(event.target.value)}
              placeholder={phone ? 'Search screens and actions' : 'Search screens and actions…'} aria-label="Search screens and actions"
              autoComplete="off" enterKeyHint="go" aria-controls="search-panel-results"
              aria-activedescendant={flat[active] ? `search-panel-item-${active}` : undefined} />
            {query && (
              <button type="button" className="search-panel-clear" onClick={() => { setQuery(''); input.current?.focus(); }} aria-label="Clear the search">
                <X size={16} aria-hidden="true" />
              </button>
            )}
          </label>
          {!phone && <button type="button" className="search-panel-esc" onClick={onClose} aria-label="Close search">Esc</button>}
        </div>

        <div className="search-panel-results" id="search-panel-results" role="listbox" aria-label="Results" ref={list}>
          {groups.map((group) => (
            <section key={group.title} className="search-panel-group" aria-label={group.title}>
              <h3>{group.title}</h3>
              {group.items.map((item) => {
                index += 1;
                const i = index;
                const Icon = item.icon;
                return (
                  <button key={`${group.title}:${item.id}`} type="button" role="option" id={`search-panel-item-${i}`} data-index={i}
                    aria-selected={i === active} aria-current={item.id === currentId ? 'page' : undefined}
                    className={`search-panel-item ${i === active ? 'is-active' : ''}`}
                    onMouseEnter={() => setActive(i)} onClick={() => choose(item)}>
                    <span className="search-panel-icon" aria-hidden="true">{Icon && <Icon size={18} />}</span>
                    <span className="search-panel-text">
                      <strong>{item.label}</strong>
                      {item.hint && <em>{item.hint}</em>}
                    </span>
                    {item.id === currentId && <span className="search-panel-here">You are here</span>}
                    {phone ? <ChevronRight size={17} className="search-panel-go" aria-hidden="true" />
                      : i === active && <CornerDownLeft size={15} className="search-panel-go" aria-hidden="true" />}
                  </button>
                );
              })}
            </section>
          ))}
          {flat.length === 0 && (
            <p className="search-panel-empty">Nothing matches “{query.trim()}”. Try a screen name, like <strong>payslips</strong> or <strong>leave</strong>.</p>
          )}
        </div>
        {!phone && (
          <div className="search-panel-foot" aria-hidden="true">
            <span><kbd>↑</kbd><kbd>↓</kbd> to move</span><span><kbd>Enter</kbd> to open</span><span><kbd>Esc</kbd> to close</span>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
