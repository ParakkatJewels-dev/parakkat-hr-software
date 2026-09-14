import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Eye, EyeOff, KeyRound, Loader2, Mail, X } from 'lucide-react';
import { useSendPasswordReset, useSetManagedUserPassword } from '../data/admin';
import { temporaryPasswordProblem } from '../lib/adminPasswords';
import { MIN_LENGTH } from '../lib/passwordRules';
import { RESET_REQUEST_MESSAGE } from '../lib/passwordRecovery';
import { btnClass } from './ui/Btn';

const INPUT = 'w-full rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 px-3 py-2.5 text-base text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:opacity-60';

export default function ManagePasswordDialog({ target, currentUserId, onClose, onSuccess }) {
  const self = target.user_id === currentUserId;
  const [method, setMethod] = useState(self ? 'email' : 'temporary');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sendReset = useSendPasswordReset();
  const setTemporary = useSetManagedUserPassword();
  const id = useId();
  const panel = useRef(null);
  const close = useRef(null);
  const latest = useRef({ busy, onClose });
  latest.current = { busy, onClose };

  useEffect(() => {
    const previous = document.activeElement;
    close.current?.focus();
    const keydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!latest.current.busy) latest.current.onClose();
      }
      if (event.key !== 'Tab') return;
      const items = [...(panel.current?.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), [tabindex="0"]') ?? [])];
      const first = items[0], last = items[items.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  const changeMethod = (next) => {
    if (busy) return;
    setMethod(next); setError(''); setPassword(''); setConfirm(''); setShow(false);
  };
  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (method === 'temporary') {
      if (self) return;
      const problem = temporaryPasswordProblem(password, confirm);
      if (problem) { setError(problem); return; }
    }
    setBusy(true);
    try {
      if (method === 'temporary') {
        await setTemporary({ user_id: target.user_id, password });
        setPassword(''); setConfirm('');
        onSuccess(`Temporary password saved for ${target.email}. They must choose a new password at their next sign-in.`);
      } else {
        await sendReset.mutateAsync(target.email);
        onSuccess(RESET_REQUEST_MESSAGE);
      }
    } catch (err) {
      setError(err.message || 'Could not update this account. Please try again.');
    } finally { setBusy(false); }
  };

  const dialog = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/70 backdrop-blur-sm p-4" onClick={() => { if (!busy) onClose(); }}>
      <section ref={panel} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-account`} aria-busy={busy}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-charcoal-900 p-5 sm:p-6 shadow-2xl space-y-5">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={`${id}-title`} className="flex items-center gap-2 text-lg font-bold text-neutral-900 dark:text-white"><KeyRound size={19} className="text-brand-ink" /> Manage password</h2>
            <p id={`${id}-account`} className="mt-1 text-sm text-neutral-500 dark:text-neutral-400 break-all">{target.employee_name && <strong className="block text-neutral-700 dark:text-neutral-200">{target.employee_name}</strong>}{target.email}</p>
          </div>
          <button ref={close} type="button" disabled={busy} onClick={onClose} aria-label="Close password management" className={btnClass('ghost', 'md', true)}><X size={18} /></button>
        </header>

        {self && <p className="rounded-xl bg-neutral-50 dark:bg-neutral-950 p-4 text-sm text-neutral-600 dark:text-neutral-300">
          This is your account. <Link to="/settings" onClick={onClose} className="font-semibold text-brand-ink underline">Open Settings → Security to change your password</Link>, or request a reset email below.
        </p>}

        <form onSubmit={submit} className="space-y-4">
          {!self && <fieldset disabled={busy} className="space-y-2">
            <legend className="mb-2 text-sm font-semibold text-neutral-700 dark:text-neutral-200">Choose how to reset the password</legend>
            {[['temporary', 'Set temporary password', KeyRound], ['email', 'Send reset email', Mail]].map(([value, label, Icon]) => (
              <label key={value} className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-sm font-semibold ${method === value ? 'border-brand bg-brand/10 text-brand-ink' : 'border-neutral-200 dark:border-neutral-800 text-neutral-600 dark:text-neutral-300'}`}>
                <input type="radio" name={`${id}-method`} value={value} checked={method === value} onChange={() => changeMethod(value)} className="accent-brand" />
                <Icon size={16} aria-hidden="true" /> {label}
              </label>
            ))}
          </fieldset>}

          {method === 'temporary' && !self ? <>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">Their current password will be replaced immediately. Share the temporary password privately; they must choose a new one at their next sign-in.</p>
            <div className="space-y-1.5">
              <label htmlFor={`${id}-password`} className="block text-sm font-semibold text-neutral-700 dark:text-neutral-200">Temporary password</label>
              <div className="relative">
                <input id={`${id}-password`} type={show ? 'text' : 'password'} autoComplete="new-password" required minLength={MIN_LENGTH}
                  disabled={busy} value={password} onChange={(event) => setPassword(event.target.value)} aria-describedby={`${id}-rules`} className={`${INPUT} pr-12`} />
                <button type="button" disabled={busy} aria-label={show ? 'Hide passwords' : 'Show passwords'} onClick={() => setShow(!show)} className="absolute right-1 top-1/2 -translate-y-1/2 rounded-lg p-2.5 text-neutral-500 hover:text-brand-ink focus-visible:outline-2 focus-visible:outline-brand cursor-pointer">
                  {show ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <p id={`${id}-rules`} className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">At least {MIN_LENGTH} characters · Not only numbers · Up to 72 bytes (special characters may use more than one)</p>
            </div>
            <div className="space-y-1.5">
              <label htmlFor={`${id}-confirm`} className="block text-sm font-semibold text-neutral-700 dark:text-neutral-200">Confirm temporary password</label>
              <input id={`${id}-confirm`} type={show ? 'text' : 'password'} autoComplete="new-password" required minLength={MIN_LENGTH}
                disabled={busy} value={confirm} onChange={(event) => setConfirm(event.target.value)} className={INPUT} />
            </div>
          </> : <p className="text-sm text-neutral-500 dark:text-neutral-400">Request a reset link for <strong className="break-all">{target.email}</strong>. Their password stays unchanged until they use the link.</p>}

          {error && <p role="alert" className="rounded-xl bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-600 dark:text-red-300">{error}</p>}
          <footer className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 border-t border-neutral-100 dark:border-neutral-800 pt-4">
            <button type="button" disabled={busy} onClick={onClose} className={btnClass('ghost')}>Cancel</button>
            <button type="submit" disabled={busy} className={btnClass('primary')}>
              {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
              {busy ? (method === 'temporary' ? 'Saving password…' : 'Requesting reset…') : (method === 'temporary' ? 'Set temporary password' : 'Send reset email')}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
  // Route transitions create a stacking context. Place the dialog above the shell header/nav,
  // including on short phone screens where the dialog itself must scroll.
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}
