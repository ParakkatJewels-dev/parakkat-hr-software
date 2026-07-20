import React, { useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabaseClient';

export default function ChangePassword() {
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setMsg(null);
    if (pw.length < 6) return setMsg({ err: 'Password must be at least 6 characters.' });
    if (pw !== confirm) return setMsg({ err: 'Passwords do not match.' });
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) setMsg({ err: error.message });
    else {
      setMsg({ ok: 'Password updated.' });
      setPw('');
      setConfirm('');
    }
  };

  return (
    <div className="premium-card p-5 space-y-4 max-w-md">
      <h3 className="font-semibold text-base text-neutral-800 dark:text-white flex items-center gap-2">
        <KeyRound size={16} className="text-gold-500" /> Change Password
      </h3>
      <form onSubmit={submit} className="space-y-3 text-xs">
        <div className="space-y-1">
          <label className="text-neutral-500 font-semibold">New password</label>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} className={INPUT} placeholder="••••••••" />
        </div>
        <div className="space-y-1">
          <label className="text-neutral-500 font-semibold">Confirm password</label>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={INPUT} placeholder="••••••••" />
        </div>
        {msg?.err && <p className="text-[11px] text-red-500">{msg.err}</p>}
        {msg?.ok && <p className="text-[11px] text-emerald-600 dark:text-emerald-400">{msg.ok}</p>}
        <button type="submit" disabled={busy} className="flex items-center gap-1.5 bg-black dark:bg-gold-450 dark:text-charcoal-900 text-white text-xs font-semibold px-3.5 py-2 rounded-xl hover:opacity-90 disabled:opacity-60 cursor-pointer">
          {busy && <Loader2 size={13} className="animate-spin" />} Update password
        </button>
      </form>
    </div>
  );
}

const INPUT = 'w-full text-sm rounded-xl px-3 py-2 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-gold-500';
