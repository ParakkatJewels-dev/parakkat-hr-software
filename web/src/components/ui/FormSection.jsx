// Inline form panel — the replacement for "create/edit" modals.
//
// Why not a modal: these forms are part of the page's workflow, not an interruption of it. A
// modal hides the list you are adding to, traps focus, needs its own scroll container on a phone,
// and stacks badly when a second one opens. An inline section keeps the surrounding context
// visible, scrolls with the page, and needs no z-index at all.
//
// Modals are still right for destructive confirmations — see ConfirmDialog.
import React, { useEffect, useRef } from 'react';
import { X, AlertTriangle, Loader2 } from 'lucide-react';
import { btnClass } from './Btn';

export const FIELD =
  'w-full text-xs rounded-xl px-3 py-2 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 placeholder:text-neutral-400 focus:outline-none focus:border-[#0ea971] focus:ring-2 focus:ring-[#0ea971]/20 transition-colors';

/** Labelled field wrapper — every input gets a real <label>, not a placeholder standing in for one. */
export function Field({ label, htmlFor, hint, required, children, className = '' }) {
  return (
    <div className={className}>
      <label
        htmlFor={htmlFor}
        className="block text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-1"
      >
        {label}
        {required && <span className="text-rose-500 ml-0.5" aria-hidden="true">*</span>}
        {hint && <span className="ml-1.5 font-normal normal-case tracking-normal text-2xs text-neutral-400">{hint}</span>}
      </label>
      {children}
    </div>
  );
}

export function FormError({ message }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-2.5"
    >
      <AlertTriangle size={13} className="text-rose-500 shrink-0 mt-0.5" />
      <p className="text-xs text-rose-600 dark:text-rose-300 break-words">{message}</p>
    </div>
  );
}

/**
 * @param title      heading shown in the panel header
 * @param subtitle   optional one-line explanation
 * @param onClose    close handler (also bound to Escape)
 * @param onSubmit   when given, the panel renders as a <form>
 * @param submitLabel / busy / error / disabled  action-row state
 */
export default function FormSection({
  title,
  subtitle,
  icon: Icon,
  onClose,
  onSubmit,
  submitLabel = 'Save',
  busy = false,
  error,
  disabled = false,
  children,
  footer,
}) {
  const ref = useRef(null);

  // The latest onClose, without making the effects below depend on its identity. Every caller
  // passes an inline arrow, so a new function arrives on every render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Escape closes. Bound once and routed through the ref, so re-binding never costs anything.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onCloseRef.current?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Focus the first field, ONCE, when the panel opens — and scroll it into view. Several of these
  // panels render after the list they belong to; editing row 3 of 264 in the Directory would
  // otherwise open a form below the pagination controls with no visible sign anything happened.
  //
  // The empty dependency array is load-bearing. This used to depend on [onClose], which every
  // caller supplies as an inline arrow — so the effect re-ran on EVERY render, and typing a single
  // character anywhere in the form threw focus back to the first input. Twenty-odd fields on the
  // asset form made it unusable; it was wrong on every form that has more than one.
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    ref.current?.querySelector('input, select, textarea, button')?.focus({ preventScroll: true });
  }, []);

  const Tag = onSubmit ? 'form' : 'div';

  return (
    <Tag
      ref={ref}
      {...(onSubmit ? { onSubmit } : {})}
      className="premium-card form-section space-y-4 animate-fade-in scroll-mt-4"
    >
      <div className="form-section-header flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {Icon && <Icon size={15} className="text-[#0ea971] shrink-0" />}
          <div className="min-w-0">
            <h3 className="font-bold text-sm text-neutral-900 dark:text-white">{title}</h3>
            {subtitle && <p className="form-section-subtitle text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">{subtitle}</p>}
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${title}`}
            className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-[#0ea971]/40 cursor-pointer shrink-0 transition-colors"
          >
            <X size={16} />
          </button>
        )}
      </div>

      {children}
      <FormError message={error} />

      {(onSubmit || footer) && (
        <div className="flex flex-col-reverse sm:flex-row sm:items-center gap-2 pt-3 border-t border-neutral-200/70 dark:border-neutral-850">
          {footer}
          <div className="form-section-actions flex flex-col-reverse sm:flex-row gap-2 sm:ml-auto">
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                className={btnClass('ghost')}
              >
                Cancel
              </button>
            )}
            {onSubmit && (
              <button
                type="submit"
                disabled={busy || disabled}
                className={btnClass('primary')}
              >
                {busy && <Loader2 size={12} className="animate-spin" />}
                {submitLabel}
              </button>
            )}
          </div>
        </div>
      )}
    </Tag>
  );
}
