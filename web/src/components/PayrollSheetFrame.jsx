import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Maximize2, Minimize2 } from 'lucide-react';
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
  const fullscreenButton = useRef(null);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [fullscreenNotice, setFullscreenNotice] = useState('');
  const supportsFullscreen = Boolean(host?.requestFullscreen && document.fullscreenEnabled);
  const wasExpanded = useRef(expanded);
  const returningPosition = useRef(retained?.position ?? null);
  const restored = useRef(false);
  const rememberPosition = target => {
    if (!host || !setRetained) return;
    const position = capturePayrollSheetPosition(host, document.getElementById('main-content'), target);
    setRetained(current => ({ ...current, expanded, position }));
  };
  const enterFullscreen = () => {
    if (!supportsFullscreen) return;
    setFullscreenNotice('');
    host.requestFullscreen({ navigationUI: 'hide' }).catch(() => {
      setFullscreenNotice('Browser full screen is unavailable. The worksheet still fills this window.');
    });
  };
  const returnToPayroll = () => {
    if (host && document.fullscreenElement === host) {
      document.exitFullscreen().then(() => setExpanded(false)).catch(() => {
        setFullscreenNotice('Press Esc to leave browser full screen, then return to payroll.');
      });
    } else setExpanded(false);
  };
  const expandSheet = () => {
    // Reparent before requesting fullscreen: moving its target later ends native fullscreen.
    if (host) {
      if (host.parentElement !== document.body) document.body.appendChild(host);
      host.classList.add('payroll-sheet-expanded');
    }
    setExpanded(true);
    enterFullscreen();
  };
  useEffect(() => {
    if (!host) return;
    const changed = () => {
      setNativeFullscreen(document.fullscreenElement === host);
      if (!document.fullscreenElement) fullscreenButton.current?.focus({ preventScroll: true });
    };
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, [host]);
  useEffect(() => {
    if (!host) return;
    const destination = expanded ? document.body : anchor.current;
    if (destination && host.parentElement !== destination) destination.appendChild(host);
    host.className = `payroll-sheet-host payroll-workflow${expanded ? ' payroll-sheet-expanded' : ''}`;
    const returning = wasExpanded.current && !expanded;
    wasExpanded.current = expanded;
    if (!expanded) { if (returning) button.current?.focus({ preventScroll: true }); return; }
    const previousOverflow = document.body.style.overflow;
    const siblings = [...document.body.children].filter(element => element !== host);
    const inertStates = siblings.map(element => [element, element.inert]);
    siblings.forEach(element => { element.inert = true; });
    document.body.style.overflow = 'hidden';
    button.current?.focus({ preventScroll: true });
    const keydown = event => {
      // A confirmation inside the worksheet owns Escape and its own focus trap.
      if (host.querySelector('[role="alertdialog"]')) return;
      if (event.key === 'Escape') {
        // Native Escape leaves the edge-to-edge worksheet and unsaved entries in place.
        if (document.fullscreenElement === host) return;
        event.preventDefault(); setExpanded(false);
      }
      if (event.key !== 'Tab') return;
      const items = [...host.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')]
        .filter(element => element.tabIndex >= 0 && element.getClientRects().length && !element.closest('[inert]'));
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
  const control = <button ref={button} type="button" className={btnClass('ghost')}
    onClick={expanded ? returnToPayroll : expandSheet}>
    {expanded ? <ArrowLeft size={14} /> : <Maximize2 size={14} />}{expanded ? 'Back to payroll' : 'Full screen'}
  </button>;
  const fullscreenControl = expanded && supportsFullscreen && <button ref={fullscreenButton} type="button"
    className={btnClass('ghost')} aria-pressed={nativeFullscreen} onClick={() => {
      if (document.fullscreenElement === host) document.exitFullscreen().catch(() => setFullscreenNotice('Press Esc to leave browser full screen.'));
      else enterFullscreen();
    }}>
    {nativeFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}{nativeFullscreen ? 'Exit full screen' : 'Full screen'}
  </button>;
  const content = <div className="payroll-sheet-content" role={expanded ? 'dialog' : undefined}
    aria-modal={expanded || undefined} aria-label={expanded ? title : undefined}>
    {fullscreenNotice && <p className="payroll-fullscreen-notice" role="status">{fullscreenNotice}</p>}
    {children({ control, fullscreenControl, expanded, title, rememberPosition })}
  </div>;
  return <div ref={anchor} className="payroll-sheet-anchor">{host ? createPortal(content, host) : content}</div>;
}
