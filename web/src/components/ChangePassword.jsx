import React, { useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabaseClient';
import { btnClass } from './ui/Btn';

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
    <div className="premium-card space-y-4">
      <h3 className="font-semibold text-base text-neutral-800 dark:text-white flex items-center gap-2">
        <KeyRound size={16} className="text-[#0ea971]" /> Change Password
      </h3>
      <form onSubmit={submit} className="space-y-3 text-xs max-w-md">
        <div className="space-y-1">
          <label className="text-neutral-500 font-semibold">New password</label>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} className={INPUT} placeholder="••••••••" />
        </div>
        <div className="space-y-1">
          <label className="text-neutral-500 font-semibold">Confirm password</label>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={INPUT} placeholder="••••••••" />
        </div>
        {msg?.err && <p className="text-xs text-red-500">{msg.err}</p>}
        {msg?.ok && <p className="text-xs text-emerald-600 dark:text-emerald-400">{msg.ok}</p>}
        <button type="submit" disabled={busy} className={btnClass('primary')}>
          {busy && <Loader2 size={13} className="animate-spin" />} Update password
        </button>
      </form>
    </div>
  );
}

const INPUT = 'w-full text-sm rounded-xl px-3 py-2 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-[#0ea971]';
