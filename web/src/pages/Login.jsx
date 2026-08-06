// Login screen. Guards the entire app: no session -> this is all you can see.
import { useState } from 'react';
import {
  AlertTriangle,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  LogIn,
  Mail,
  MapPin,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import BrandMark from '../components/ui/BrandMark';
import { useAuth } from '../auth/AuthContext';
import { isSupabaseConfigured } from '../lib/supabaseClient';

const LOGIN_INPUT =
  'w-full rounded-xl border border-neutral-200 bg-white/85 px-10 py-3 text-[16px] text-neutral-900 shadow-sm outline-none transition focus:border-[#0ea971] focus:ring-4 focus:ring-[#0ea971]/10 dark:border-neutral-800 dark:bg-neutral-950/70 dark:text-warm-gray-100';

function LoginField({ icon: Icon, label, children }) {
  return (
    <label className="block">
      <span className="block text-sm font-semibold text-neutral-700 dark:text-neutral-250 mb-1.5">
        {label}
      </span>
      <span className="relative block">
        <Icon
          size={17}
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400"
        />
        {children}
      </span>
    </label>
  );
}

export default function Login() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

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
    <div className="login-screen min-h-screen bg-[#eef3ef] text-neutral-900 dark:bg-charcoal-900 dark:text-warm-gray-100">
      <div className="login-shell mx-auto grid min-h-screen w-full max-w-6xl items-center gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[1.05fr_.95fr] lg:px-8">
        <section className="login-brand-panel hidden min-h-[34rem] overflow-hidden rounded-[2rem] border border-white/60 bg-[#073f31] p-8 text-white shadow-2xl shadow-emerald-950/20 lg:flex lg:flex-col lg:justify-between">
          <div className="relative z-10 flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-[#073f31] shadow-lg">
              <BrandMark size={30} title="Parakkat Jewels" />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase text-white/65">Parakkat Group</p>
              <h1 className="text-2xl font-extrabold tracking-normal">HRMS</h1>
            </div>
          </div>

          <div className="relative z-10 max-w-md space-y-5">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white/80">
              <Sparkles size={14} aria-hidden="true" />
              One workspace for every team
            </div>
            <div className="space-y-3">
              <h2 className="text-4xl font-black leading-tight tracking-normal">
                Start the day with the right access.
              </h2>
              <p className="max-w-sm text-sm leading-6 text-white/72">
                Attendance, leave, payroll, documents, and approvals open by role, branch, and
                department.
              </p>
            </div>
          </div>

          <div className="relative z-10 grid grid-cols-3 gap-3 text-xs">
            {[
              ['Live', 'Attendance'],
              ['Fast', 'Approvals'],
              ['Scoped', 'Access'],
            ].map(([top, bottom]) => (
              <div key={bottom} className="rounded-2xl border border-white/12 bg-white/10 p-3">
                <p className="font-bold">{top}</p>
                <p className="mt-1 text-white/58">{bottom}</p>
              </div>
            ))}
          </div>

          <div className="login-brand-pattern" aria-hidden="true" />
        </section>

        <main className="flex w-full justify-center lg:justify-end">
          <div className="w-full max-w-md">
            <div className="mb-5 flex items-center gap-3 lg:hidden">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#0ea971] text-white shadow-[0_10px_26px_rgba(14,169,113,.28)]">
                <BrandMark size={29} title="Parakkat Jewels" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase text-neutral-500 dark:text-neutral-400">
                  Parakkat Group
                </p>
                <h1 className="text-xl font-extrabold tracking-normal">HRMS</h1>
              </div>
            </div>

            <div className="login-card overflow-hidden rounded-[1.75rem] border border-white/80 bg-white/90 p-6 shadow-2xl shadow-emerald-950/10 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/72 dark:shadow-black/30 sm:p-7">
              <div className="mb-6 flex items-start justify-between gap-4">
                <div>
                  <p className="inline-flex items-center gap-1.5 rounded-full bg-[#e7f7f0] px-2.5 py-1 text-xs font-bold text-[#087a53] dark:bg-[#0ea971]/15 dark:text-[#7be0b7]">
                    <ShieldCheck size={13} aria-hidden="true" />
                    Secure sign in
                  </p>
                  <h2 className="mt-3 text-2xl font-black tracking-normal">Welcome back</h2>
                  <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                    Use your work login to continue.
                  </p>
                </div>
                <div className="hidden h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-neutral-950 text-white dark:bg-[#0ea971] dark:text-charcoal-950 sm:flex">
                  <BrandMark size={28} title="Parakkat Jewels" />
                </div>
              </div>

              {!isSupabaseConfigured && (
                <div className="mb-5 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  <span>
                    Backend not configured. Add Supabase keys to <code>.env.local</code>.
                  </span>
                </div>
              )}

              <form onSubmit={onSubmit} className="space-y-4">
                <LoginField icon={Mail} label="Work email">
                  <input
                    type="email"
                    required
                    autoFocus
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@parakkatjewels.com"
                    className={LOGIN_INPUT}
                  />
                </LoginField>

                <LoginField icon={KeyRound} label="Password">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter password"
                    className={`${LOGIN_INPUT} pr-11`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((value) => !value)}
                    className="absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-850 dark:hover:text-neutral-100"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </LoginField>

                {error && (
                  <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-400">
                    {error}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={busy}
                  className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-[#073f31] py-3 text-sm font-bold text-white shadow-lg shadow-emerald-950/15 transition hover:bg-[#0b563f] disabled:cursor-not-allowed disabled:opacity-60 dark:bg-[#0ea971] dark:text-charcoal-950 dark:hover:bg-[#25c98f]"
                >
                  {busy ? <Loader2 size={17} className="animate-spin" /> : <LogIn size={17} />}
                  {busy ? 'Signing in...' : 'Sign in'}
                </button>
              </form>
            </div>

            <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-500">
              <MapPin size={13} aria-hidden="true" />
              Branch and department access applies after sign in.
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}
