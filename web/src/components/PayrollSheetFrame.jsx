import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minimize2 } from 'lucide-react';
import { btnClass } from './ui/Btn';
import { usePayrollSessionState } from '../lib/usePayrollSessionState';
import { capturePayrollSheetPosition, restorePayrollSheetPosition } from '../lib/payrollSheetPosition';
import './payrollSheetFrame.css';

// Move a stable portal host instead of remounting the sheet: cell drafts, selection,
// filters and scroll positions survive entering and leaving the full-screen workspace.
export default function PayrollSheetFrame(props) {
  return props.sessionKey ? <RetainedPayrollSheetFrame {...props} /> : <SheetFrame {...props} />;
}

function RetainedPayrollSheetFrame({ sessionKey, defaultExpanded = false, ...props }) {
  const [retained, setRetained] = usePayrollSessionState(sessionKey, () => ({ expanded: defaultExpanded, position: null }));
  return <SheetFrame {...props} defaultExpanded={defaultExpanded} retained={retained} setRetained={setRetained} />;
}

function SheetFrame({ title, children, defaultExpanded = false, retained, setRetained, restoreReady = true }) {
  const [localExpanded, setLocalExpanded] = useState(defaultExpanded);
  const expanded = retained?.expanded ?? localExpanded;
  const setExpanded = useCallback(update => {
    if (setRetained) setRetained(current => ({ ...current,
      expanded: typeof update === 'function' ? update(current.expanded) : update }));
    else setLocalExpanded(update);
  }, [setRetained]);
  const [host] = useState(() => typeof document === 'undefined' ? null : document.createElement('div'));
  const anchor = useRef(null);
  const button = useRef(null);
  const wasExpanded = useRef(expanded);
  const returningPosition = useRef(retained?.position ?? null);
  const restored = useRef(false);
  const rememberPosition = target => {
    if (!host || !setRetained) return;
    const position = capturePayrollSheetPosition(host, document.getElementById('main-content'), target);
    setRetained(current => ({ ...current, expanded, position }));
  };
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
  }, [host, expanded, setExpanded]);
  useEffect(() => {
    if (!host || !restoreReady || restored.current || !returningPosition.current) return undefined;
    return restorePayrollSheetPosition(host, document.getElementById('main-content'), returningPosition.current,
      () => { restored.current = true; });
  }, [host, restoreReady, expanded]);
  useEffect(() => () => host?.remove(), [host]);
  const control = <button ref={button} type="button" className={btnClass('ghost')} aria-pressed={expanded}
    onClick={() => setExpanded(value => !value)}>
    {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}{expanded ? 'Exit full screen' : 'Full screen'}
  </button>;
  const content = <div className="payroll-sheet-content" role={expanded ? 'dialog' : undefined}
    aria-modal={expanded || undefined} aria-label={expanded ? title : undefined}>
    {expanded && <div className="payroll-sheet-caption"><span>{title}</span><span>Esc to return to payroll</span></div>}
    {children({ control, expanded, rememberPosition })}
  </div>;
  return <div ref={anchor} className="payroll-sheet-anchor">{host ? createPortal(content, host) : content}</div>;
}
