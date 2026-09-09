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
import { KeyRound, Loader2, LogOut, Eye, EyeOff, Check } from 'lucide-react';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../auth/AuthContext';
import { btnClass } from './ui/Btn';
import { humanDbError } from '../lib/dbErrors';
import { passwordProblem, RULES } from '../lib/passwordRules';

const INPUT =
  'w-full text-sm rounded-xl px-3 py-2.5 pr-10 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 ' +
  'dark:border-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:border-[#0ea971] ' +
  'focus:ring-2 focus:ring-[#0ea971]/20 transition-colors';

export default function SetYourPassword() {
  const { user, employee, signOut, reloadAccess } = useAuth();
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Checked as they type so nothing is refused only at the end — but the message under the field
  // only appears once they have started, so an untouched form is not already complaining.
  const problem = passwordProblem(pw, { name: employee?.full_name, email: user?.email });
  const mismatch = confirm.length > 0 && pw !== confirm;
  const ready = !problem && !mismatch && confirm.length > 0;

  const submit = async (e) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.updateUser({ password: pw });
    if (err) {
      setBusy(false);
      setError(humanDbError(err) ?? err.message);
      return;
    }
    // The trigger has cleared the flag by now; re-read access so the gate comes down.
    await reloadAccess();
    setBusy(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-50 dark:bg-charcoal-900 px-5 py-10">
      <div className="w-full max-w-md space-y-5">
        <div className="text-center space-y-2">
          <div className="w-14 h-14 rounded-2xl bg-[#0ea971]/12 text-[#0a7d53] dark:text-[#10b981] flex items-center justify-center mx-auto">
            <KeyRound size={24} />
          </div>
          <h1 className="text-lg font-bold text-neutral-900 dark:text-warm-gray-100">Choose your password</h1>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 leading-relaxed max-w-sm mx-auto">
            You signed in with the password you were given. Anyone who knows your name and phone
            number could work that one out, so pick your own before you carry on.
          </p>
        </div>

        <form onSubmit={submit} className="premium-card space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="new-pw" className="block text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
              New password
            </label>
            <div className="relative">
              <input
                id="new-pw" type={show ? 'text' : 'password'} value={pw} autoFocus
                autoComplete="new-password"
                onChange={(e) => setPw(e.target.value)}
                className={INPUT}
                aria-describedby="pw-rules"
              />
              <button
                type="button" onClick={() => setShow((v) => !v)}
                aria-label={show ? 'Hide password' : 'Show password'}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-neutral-400 hover:text-neutral-900 dark:hover:text-white cursor-pointer"
              >
                {show ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
            {/* The rules are shown up front rather than as errors after the fact. */}
            <ul id="pw-rules" className="space-y-0.5 pt-1">
              {RULES.map((rule) => {
                const met = pw.length > 0 && rule.ok(pw, { name: employee?.full_name, email: user?.email });
                return (
                  <li key={rule.id} className={`flex items-center gap-1.5 text-2xs ${
                    met ? 'text-[#0a7d53] dark:text-[#10b981]' : 'text-neutral-400'
                  }`}>
                    <Check size={11} className={met ? '' : 'opacity-30'} aria-hidden="true" />
                    {rule.label}
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="confirm-pw" className="block text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
              Type it again
            </label>
            <input
              id="confirm-pw" type={show ? 'text' : 'password'} value={confirm}
              autoComplete="new-password"
              onChange={(e) => setConfirm(e.target.value)}
              className={INPUT}
            />
            {mismatch && (
              <p className="text-2xs text-red-600 dark:text-red-300">Those two do not match.</p>
            )}
          </div>

          {error && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-300 break-words">{error}</p>
          )}

          <button type="submit" disabled={!ready || busy} className={btnClass('success', 'lg') + ' w-full'}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
            Save and continue
          </button>
        </form>

        <div className="text-center">
          <button
            onClick={signOut}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white cursor-pointer"
          >
            <LogOut size={13} /> Sign out{user?.email ? ` (${user.email})` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
