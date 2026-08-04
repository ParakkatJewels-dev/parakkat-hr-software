// Confirmation dialog — the one job a modal is genuinely right for.
//
// A destructive action must interrupt, must be answered before anything else happens, and is
// short enough that hiding the page behind it costs nothing. Everything else in this app that
// used to be a modal is now an inline FormSection.
//
// Accessibility: labelled dialog role, Escape to cancel, focus moves in on open and returns to
// wherever it came from on close, and the confirm button is never the default focus so nobody
// deletes something by hitting Enter out of habit.
import React, { useEffect, useRef } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';

export default function ConfirmDialog({
  title,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  busy = false,
  error,
  tone = 'danger', // 'danger' | 'primary'
}) {
  const panelRef = useRef(null);
  const cancelRef = useRef(null);
  const restoreTo = useRef(null);

  useEffect(() => {
    restoreTo.current = document.activeElement;
    cancelRef.current?.focus();

    const onKey = (e) => {
      if (e.key === 'Escape') {
        onCancel?.();
        return;
      }
      // Keep Tab inside the dialog while it is open.
      if (e.key !== 'Tab' || !panelRef.current) return;
      const items = panelRef.current.querySelectorAll(
        'button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // Send focus back where the user was, not to the top of the document.
      if (restoreTo.current instanceof HTMLElement) restoreTo.current.focus();
    };
  }, [onCancel]);

  const confirmClass =
    tone === 'danger'
      ? 'bg-red-600 hover:bg-red-700 focus:ring-red-500/40'
      : 'bg-[#0ea971] hover:bg-[#0c9765] focus:ring-[#0ea971]/40';

  return (
    // z-50 is the app's top layer (see the scale used across the shell: 30 header, 50 overlay).
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/70 backdrop-blur-sm p-4 animate-fade-in"
      onClick={onCancel}
    >
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onClick={(e) => e.stopPropagation()}
        className="confirm-panel w-full max-w-md rounded-2xl bg-white dark:bg-charcoal-900 border border-neutral-200 dark:border-neutral-800 shadow-2xl p-5 space-y-4"
      >
        <div className="flex items-start gap-3">
          <div
            className={`shrink-0 w-9 h-9 rounded-xl flex items-center justify-center ${
              tone === 'danger'
                ? 'bg-red-100 text-red-600 dark:bg-red-950/40 dark:text-red-400'
                : 'bg-[#0ea971]/10 text-[#0ea971]'
            }`}
          >
            <AlertTriangle size={17} />
          </div>
          <div className="min-w-0">
            <h2 id="confirm-title" className="text-sm font-bold text-neutral-900 dark:text-white">
              {title}
            </h2>
            <div className="text-sm text-neutral-600 dark:text-neutral-300 mt-1.5 space-y-1.5 leading-relaxed">
              {children}
            </div>
          </div>
        </div>

        {error && (
          <p role="alert" className="text-xs text-rose-500 break-words">
            {error}
          </p>
        )}

        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-1">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-neutral-200 dark:border-neutral-800 px-4 py-2 text-base font-bold text-neutral-600 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-neutral-400/40 cursor-pointer transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-base font-bold text-white focus:outline-none focus:ring-2 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed transition-colors ${confirmClass}`}
          >
            {busy && <Loader2 size={12} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
