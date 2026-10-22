// The one screen a newly provisioned account sees first.
//
// Logins are created in bulk from the employee record, so the first password is derived from the
// person's own name and phone number — which is fine for handing an account over and not fine for
// keeping one, because every colleague can compute it. This stands between that password and the
// rest of the app: payslips, bank details, PAN, Aadhaar.
//
// It is a full screen rather than a dismissible prompt, because a prompt is a thing people close.
// Sign out stays available — somebody who opened the wrong account must not be trapped in it — and
// that is the only way past.
//
// The flag itself is cleared by a trigger on the password column (0111), not by this component
// saying so. All we do here is change the password and re-read access; if the change did not
// actually happen, the gate is still up, which is the correct outcome.
import React, { useState } from 'react';
import { KeyRound, Loader2, LogOut, Eye, EyeOff, Check, Lock } from 'lucide-react';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../auth/AuthContext';
import AuthLayout from '../pages/AuthLayout';
import { humanDbError } from '../lib/dbErrors';
import { passwordProblem, RULES } from '../lib/passwordRules';

export default function SetYourPassword({ recovery = false }) {
  const { user, signOut, reloadAccess, finishRecovery } = useAuth();
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Checked as they type so nothing is refused only at the end — but the message under the field
  // only appears once they have started, so an untouched form is not already complaining.
  const problem = passwordProblem(pw);
  const mismatch = confirm.length > 0 && pw !== confirm;
  const ready = !problem && !mismatch && confirm.length > 0;

  const submit = async (e) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { error: err } = await supabase.auth.updateUser({ password: pw });
      if (err) throw err;
      // Finish recovery even if refreshing permissions fails: the password itself was saved.
      await reloadAccess();
      if (recovery) finishRecovery();
    } catch (err) {
      setError(humanDbError(err) ?? err.message);
    } finally { setBusy(false); }
  };

  return (
    <AuthLayout>
      <h1>{recovery ? 'Reset your password' : 'Choose your password'}</h1>
      <p className="auth-lede">
        {recovery
          ? `Choose a new password for ${user?.email || 'your account'}.`
          : 'You signed in with a temporary password. Choose your own before you carry on.'}
      </p>

      <form onSubmit={submit}>
        <label className="auth-field" htmlFor="new-pw">
          <span>New password</span>
          <span className="auth-input-wrap">
            <Lock size={18} aria-hidden="true" />
            <input
              id="new-pw" type={show ? 'text' : 'password'} value={pw} autoFocus
              autoComplete="new-password"
              onChange={(e) => setPw(e.target.value)}
              className="auth-input has-toggle"
              aria-describedby="pw-rules"
            />
            <button
              type="button" onClick={() => setShow((v) => !v)}
              aria-label={show ? 'Hide password' : 'Show password'}
              className="auth-input-toggle"
            >
              {show ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </span>
        </label>
        {/* The rules are shown up front rather than as errors after the fact. */}
        <ul id="pw-rules" className="-mt-2 mb-4 space-y-1">
          {RULES.map((rule) => {
            const met = pw.length > 0 && rule.ok(pw);
            return (
              <li key={rule.id} className={`flex items-center gap-1.5 text-xs ${
                met ? 'text-brand-ink dark:text-brand-ink' : 'text-neutral-500 dark:text-neutral-400'
              }`}>
                <Check size={13} className={met ? '' : 'opacity-40'} aria-hidden="true" />
                {rule.label}
              </li>
            );
          })}
        </ul>

        <label className="auth-field" htmlFor="confirm-pw">
          <span>Type it again</span>
          <span className="auth-input-wrap">
            <Lock size={18} aria-hidden="true" />
            <input
              id="confirm-pw" type={show ? 'text' : 'password'} value={confirm}
              autoComplete="new-password"
              onChange={(e) => setConfirm(e.target.value)}
              className="auth-input"
            />
          </span>
        </label>
        {mismatch && <p className="-mt-2 mb-4 text-xs text-red-600 dark:text-red-300">Those two do not match.</p>}

        {error && <p role="alert" className="auth-alert break-words">{error}</p>}

        <button type="submit" disabled={!ready || busy} className="auth-submit">
          {busy ? <Loader2 size={18} className="animate-spin" /> : <KeyRound size={18} />}
          Save and continue
        </button>
      </form>

      <div className="mt-5 text-center">
        <button
          type="button"
          onClick={signOut}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white cursor-pointer"
        >
          <LogOut size={15} /> Sign out{user?.email ? ` (${user.email})` : ''}
        </button>
      </div>
    </AuthLayout>
  );
}
