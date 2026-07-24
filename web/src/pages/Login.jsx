// Login screen. Guards the entire app: no session -> this is all you can see.
import { useState } from 'react';
import { LogIn, Loader2, ShieldCheck, AlertTriangle } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { isSupabaseConfigured } from '../lib/supabaseClient';

export default function Login() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    const { error: err } = await signIn(email.trim(), password);
    setBusy(false);
    if (err) setError(err.message || 'Sign in failed. Check your credentials.');
    // On success, the auth listener flips the session and the router shows the app.
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-50 dark:bg-charcoal-900 text-neutral-900 dark:text-warm-gray-100 px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center justify-center mb-6 gap-2.5">
          <div className="w-12 h-12 bg-[#0ea971] text-white rounded-2xl flex items-center justify-center shadow-[0_8px_24px_rgba(14,169,113,.28)]">
            <ShieldCheck size={22} />
          </div>
          <div className="text-center leading-tight">
            <div className="font-extrabold tracking-wide text-neutral-900 dark:text-warm-gray-100">PARAKKAT HR</div>
            <div className="text-[9px] font-mono tracking-[0.2em] uppercase text-neutral-455 dark:text-neutral-500 mt-0.5">Group HRMS</div>
          </div>
        </div>

        <div className="bg-white dark:bg-charcoal-900 border border-neutral-200 dark:border-gold-500/15 rounded-2xl p-6 shadow-xl space-y-5">
          <div className="space-y-1">
            <h1 className="text-lg font-bold flex items-center gap-2">
              <ShieldCheck size={18} className="text-gold-500" /> Sign in
            </h1>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Access is scoped to your role, entity, and branch.
            </p>
          </div>

          {!isSupabaseConfigured && (
            <div className="flex items-start gap-2 text-[11px] bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-900/50 rounded-xl p-3">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <span>
                Backend not configured yet. Add your Supabase keys to <code>.env.local</code> and
                restart the dev server to enable login.
              </span>
            </div>
          )}

          <form onSubmit={onSubmit} className="space-y-3.5">
            <div>
              <label className="block text-[11px] font-semibold text-neutral-600 dark:text-neutral-300 mb-1">
                Work email
              </label>
              <input
                type="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@parakkatjewels.com"
                className="w-full bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-gold-500 transition-colors"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-neutral-600 dark:text-neutral-300 mb-1">
                Password
              </label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-gold-500 transition-colors"
              />
            </div>

            {error && (
              <p className="text-[11px] text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full flex items-center justify-center gap-2 bg-black dark:bg-gold-450 text-white dark:text-charcoal-900 font-semibold text-sm py-2.5 rounded-xl hover:opacity-90 disabled:opacity-60 transition-opacity cursor-pointer"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />}
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>

        <p className="text-center text-[10.5px] text-neutral-400 dark:text-neutral-600 mt-4">
          Parakkat Group HRMS · centralized admin, branch &amp; department scoped access
        </p>
      </div>
    </div>
  );
}
