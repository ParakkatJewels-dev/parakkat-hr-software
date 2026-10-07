import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minimize2 } from 'lucide-react';
import { btnClass } from './ui/Btn';
import './payrollSheetFrame.css';

// Move a stable portal host instead of remounting the sheet: cell drafts, selection,
// filters and scroll positions survive entering and leaving the full-screen workspace.
export default function PayrollSheetFrame({ title, children, defaultExpanded = false }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [host] = useState(() => typeof document === 'undefined' ? null : document.createElement('div'));
  const anchor = useRef(null);
  const button = useRef(null);
  const wasExpanded = useRef(defaultExpanded);
  useEffect(() => {
    if (!host) return;
    (expanded ? document.body : anchor.current)?.appendChild(host);
    host.className = `payroll-sheet-host payroll-workflow${expanded ? ' payroll-sheet-expanded' : ''}`;
    const returning = wasExpanded.current && !expanded;
    wasExpanded.current = expanded;
    if (!expanded) { if (returning) button.current?.focus(); return; }
    const previousOverflow = document.body.style.overflow;
    const siblings = [...document.body.children].filter(element => element !== host);
    const inertStates = siblings.map(element => [element, element.inert]);
    siblings.forEach(element => { element.inert = true; });
    document.body.style.overflow = 'hidden';
    button.current?.focus();
    const keydown = event => {
      // A confirmation inside the worksheet owns Escape and its own focus trap.
      if (host.querySelector('[role="alertdialog"]')) return;
      if (event.key === 'Escape') { event.preventDefault(); setExpanded(false); }
      if (event.key !== 'Tab') return;
      const items = [...host.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')]
        .filter(element => element.getClientRects().length);
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      document.body.style.overflow = previousOverflow;
      inertStates.forEach(([element, inert]) => { element.inert = inert; });
    };
  }, [host, expanded]);
  useEffect(() => () => host?.remove(), [host]);
  const control = <button ref={button} type="button" className={btnClass('ghost')} aria-pressed={expanded}
    onClick={() => setExpanded(value => !value)}>
    {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}{expanded ? 'Exit full screen' : 'Full screen'}
  </button>;
  const content = <div className="payroll-sheet-content" role={expanded ? 'dialog' : undefined}
    aria-modal={expanded || undefined} aria-label={expanded ? title : undefined}>
    {expanded && <div className="payroll-sheet-caption"><span>{title}</span><span>Esc to return to payroll</span></div>}
    {children({ control, expanded })}
  </div>;
  return <div ref={anchor} className="payroll-sheet-anchor">{host ? createPortal(content, host) : content}</div>;
}
