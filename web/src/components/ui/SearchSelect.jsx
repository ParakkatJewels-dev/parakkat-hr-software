// A dropdown you can type into (round 2). Long lists — people, branches, departments, categories —
// were bare <select>s: on a phone that is a wheel of 500 names with no way to jump to one.
//
// It is a drop-in for <select>: give it the same value, onChange and <option> children, and
// onChange still receives an event with `target.value`, so callers do not change. On a computer
// the list opens under the field; on a phone it opens as a sheet from the bottom. Lists longer
// than SEARCH_FROM options get a search box; shorter ones are just the list.
import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { useMediaQuery } from '../../lib/useMediaQuery';
import './searchSelect.css';

export const SEARCH_FROM = 7;

const textOf = (node) => React.Children.toArray(node).map((child) => {
  if (typeof child === 'string' || typeof child === 'number') return String(child);
  return React.isValidElement(child) ? textOf(child.props.children) : '';
}).join('');

/** The <option> children as plain options (optgroups become a group name on each option). */
export function optionsFrom(children) {
  const out = [];
  const walk = (nodes, group) => React.Children.forEach(nodes, (child) => {
    if (!React.isValidElement(child)) return;
    if (child.type === React.Fragment) return walk(child.props.children, group);
    if (child.type === 'optgroup') return walk(child.props.children, child.props.label);
    if (child.type !== 'option') return;
    const label = textOf(child.props.children).trim();
    out.push({ value: String(child.props.value ?? label), label, disabled: Boolean(child.props.disabled), group });
  });
  walk(children);
  return out;
}

/** Case- and accent-insensitive "contains". */
export const matches = (label, query) => {
  const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return norm(label).includes(norm(query).trim());
};

export default function SearchSelect({
  value, onChange, children, options: given, className = '', placeholder, disabled = false, required = false,
  id, name, title, searchPlaceholder = 'Type to search…', 'aria-label': ariaLabel, ...rest
}) {
  const options = useMemo(() => given ?? optionsFrom(children), [given, children]);
  const current = String(value ?? '');
  const selected = options.find((o) => o.value === current);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState(null);
  const trigger = useRef(null);
  const panel = useRef(null);
  const search = useRef(null);
  const listId = useId();
  const autoId = useId();
  const phone = useMediaQuery('(max-width: 640px)');
  const searchable = options.length >= SEARCH_FROM;
  const shown = useMemo(() => (query.trim() ? options.filter((o) => matches(o.label, query)) : options), [options, query]);

  const close = (refocus = true) => { setOpen(false); if (refocus) trigger.current?.focus(); };
  const openList = () => {
    if (disabled) return;
    setQuery('');
    setActive(Math.max(0, options.findIndex((o) => o.value === current)));
    setOpen(true);
  };
  const choose = (option) => {
    if (!option || option.disabled) return;
    const target = { value: option.value, name };
    onChange?.({ target, currentTarget: target });
    close();
  };

  // On a computer the list hangs under (or, near the bottom of the screen, over) the field.
  useLayoutEffect(() => {
    if (!open || phone) return undefined;
    const measure = () => {
      const r = trigger.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(Math.max(r.width, 240), window.innerWidth - 16);
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      const below = window.innerHeight - r.bottom;
      const up = below < 280 && r.top > below;
      setPlace(up ? { left, width, bottom: window.innerHeight - r.top + 4 } : { left, width, top: r.bottom + 4 });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => { window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [open, phone]);

  // A tap or click anywhere else closes it.
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event) => {
      if (!panel.current?.contains(event.target) && !trigger.current?.contains(event.target)) close(false);
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('touchstart', outside);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('touchstart', outside); };
  }, [open]);

  // Focus the search box (or the list) on open, and keep the highlighted option in view.
  useEffect(() => {
    if (!open) return;
    (search.current ?? panel.current?.querySelector('[role="listbox"]'))?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (open) panel.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);
  useEffect(() => { setActive(0); }, [query]);

  const step = (delta) => {
    if (!shown.length) return;
    let next = active;
    for (let i = 0; i < shown.length; i += 1) {
      next = (next + delta + shown.length) % shown.length;
      if (!shown[next].disabled) break;
    }
    setActive(next);
  };
  const onPanelKey = (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); step(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); step(-1); }
    else if (event.key === 'Enter') { event.preventDefault(); choose(shown[active]); }
    else if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.key === 'Tab') close(false);
  };
  const onTriggerKey = (event) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); openList(); }
  };

  const label = selected?.label ?? placeholder ?? options[0]?.label ?? 'Choose…';
  let lastGroup;
  return (
    <>
      <button {...rest} type="button" id={id ?? autoId} ref={trigger} name={name} title={title} disabled={disabled}
        className={`search-select ${className}`} aria-haspopup="listbox" aria-expanded={open}
        aria-controls={open ? listId : undefined} aria-label={ariaLabel}
        onClick={() => (open ? close() : openList())} onKeyDown={onTriggerKey}>
        <span className="search-select-value">{label}</span>
        <ChevronDown size={16} className="search-select-caret" aria-hidden="true" />
      </button>
      {/* The native select stays underneath, in step with the button: it carries `required` into
          the browser's own form check (focusing it hands focus to the button) and keeps the value
          for anything that reads the form. Hidden from sight and from assistive technology. */}
      <select className="search-select-native" tabIndex={-1} aria-hidden="true" aria-label={ariaLabel}
        value={current} required={required} disabled={disabled} name={name}
        onChange={(event) => onChange?.(event)} onFocus={() => trigger.current?.focus()}>
        {given ? given.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>) : children}
      </select>
      {open && createPortal(
        <div className={`search-select-layer ${phone ? 'is-sheet' : ''}`}>
          {phone && <div className="search-select-backdrop" aria-hidden="true" />}
          <div ref={panel} className="search-select-panel" style={phone ? undefined : place ?? { visibility: 'hidden' }} onKeyDown={onPanelKey}>
            {phone && (
              <div className="search-select-head">
                <strong>{ariaLabel ?? placeholder ?? 'Choose'}</strong>
                <button type="button" onClick={() => close()} aria-label="Close list"><X size={18} /></button>
              </div>
            )}
            {searchable && (
              <label className="search-select-search">
                <Search size={16} aria-hidden="true" />
                <input ref={search} type="search" value={query} onChange={(event) => setQuery(event.target.value)}
                  placeholder={searchPlaceholder} aria-label={`Search ${ariaLabel ?? 'options'}`} aria-controls={listId}
                  aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined} autoComplete="off" />
              </label>
            )}
            <ul role="listbox" id={listId} aria-label={ariaLabel} tabIndex={searchable ? -1 : 0}
              aria-activedescendant={!searchable && shown[active] ? `${listId}-${active}` : undefined}>
              {shown.map((option, index) => {
                const heading = option.group && option.group !== lastGroup ? option.group : null;
                lastGroup = option.group;
                return (
                  <React.Fragment key={`${option.value}-${index}`}>
                    {heading && <li className="search-select-group" role="presentation">{heading}</li>}
                    <li id={`${listId}-${index}`} data-index={index} role="option" aria-selected={option.value === current}
                      aria-disabled={option.disabled || undefined} className={index === active ? 'is-active' : undefined}
                      onMouseEnter={() => setActive(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(option)}>
                      <span>{option.label}</span>
                      {option.value === current && <Check size={16} aria-hidden="true" />}
                    </li>
                  </React.Fragment>
                );
              })}
            </ul>
            {shown.length === 0 && <p className="search-select-empty">Nothing matches “{query.trim()}”.</p>}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
