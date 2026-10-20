// Right-hand drawer (bottom sheet on phones, ≤ 860 px) for the Work Ledger: report draft, new task,
// log help and the rest. Labelled dialog, Escape closes, Tab stays inside, focus returns to where
// it came from — the same contract as ui/ConfirmDialog.jsx.
import React, { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import { btnClass } from '../ui/Btn';

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function Drawer({ title, subtitle, onClose, children, footer, initialFocus, wide = false }) {
  const panel = useRef(null);
  const restoreTo = useRef(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  useEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    restoreTo.current = document.activeElement;
    const target = initialFocus ? panel.current?.querySelector(initialFocus) : null;
    (target ?? panel.current)?.focus({ preventScroll: true });
    const onKey = (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); onCloseRef.current?.(); return; }
      if (event.key !== 'Tab' || !panel.current) return;
      const items = panel.current.querySelectorAll(FOCUSABLE);
      if (!items.length) { event.preventDefault(); panel.current.focus(); return; }
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (restoreTo.current instanceof HTMLElement) restoreTo.current.focus({ preventScroll: true });
    };
  }, [initialFocus]);

  return (
    <div className="ledger-drawer-backdrop" onClick={() => onCloseRef.current?.()}>
      <aside ref={panel} className={`ledger-drawer${wide ? ' ledger-drawer-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        onClick={(event) => event.stopPropagation()}>
        <header className="ledger-drawer-head">
          <div><h2 id={titleId}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
          <button type="button" className={btnClass('subtle', 'md', true)} onClick={() => onCloseRef.current?.()} aria-label={`Close ${title}`}><X size={18} /></button>
        </header>
        <div className="ledger-drawer-body">{children}</div>
        {footer && <footer className="ledger-drawer-foot">{footer}</footer>}
      </aside>
    </div>
  );
}
