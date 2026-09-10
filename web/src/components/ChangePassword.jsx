import React, { useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabaseClient';
import { btnClass } from './ui/Btn';
import { useAuth } from '../auth/AuthContext';
import { passwordProblem, RULES } from '../lib/passwordRules';

export default function ChangePassword() {
  const { user, employee } = useAuth();
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setMsg(null);
    const problem = passwordProblem(pw, { name: employee?.full_name, email: user?.email });
    if (problem) return setMsg({ err: problem.label });
    if (pw !== confirm) return setMsg({ err: 'Passwords do not match.' });
    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: pw });
      if (error) throw error;
      setMsg({ ok: 'Password updated.' });
      setPw('');
      setConfirm('');
    } catch (err) {
      setMsg({ err: err.message || 'Could not update your password. Please try again.' });
    } finally { setBusy(false); }
  };

  return (
    <div className="premium-card space-y-4">
      <h3 className="font-semibold text-base text-neutral-800 dark:text-white flex items-center gap-2">
        <KeyRound size={16} className="text-brand-ink" /> Change Password
      </h3>
      <form onSubmit={submit} className="space-y-3 text-xs max-w-md">
        <div className="space-y-1">
          <label htmlFor="change-password" className="text-neutral-500 font-semibold">New password</label>
          <input id="change-password" type="password" autoComplete="new-password" aria-describedby="change-password-rules" required value={pw} onChange={(e) => setPw(e.target.value)} className={INPUT} placeholder="••••••••" />
          <p id="change-password-rules" className="text-xs text-neutral-500 dark:text-neutral-400">{RULES.map((rule) => rule.label).join(' · ')}</p>
        </div>
        <div className="space-y-1">
          <label htmlFor="change-password-confirm" className="text-neutral-500 font-semibold">Confirm password</label>
          <input id="change-password-confirm" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} className={INPUT} placeholder="••••••••" />
        </div>
        {msg?.err && <p role="alert" className="text-xs text-red-500">{msg.err}</p>}
        {msg?.ok && <p role="status" className="text-xs text-brand-ink">{msg.ok}</p>}
        <button type="submit" disabled={busy} className={btnClass('primary')}>
          {busy && <Loader2 size={13} className="animate-spin" />} Update password
        </button>
      </form>
    </div>
  );
}

const INPUT = 'w-full text-sm rounded-xl px-3 py-2 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-brand';
