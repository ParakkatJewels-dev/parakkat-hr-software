import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, KeyRound, Loader2 } from 'lucide-react';
import { supabase, isSupabaseConfigured } from '../lib/supabaseClient';
import { passwordRecoveryRedirect, requestPasswordReset, RESET_REQUEST_MESSAGE } from '../lib/passwordRecovery';
import { btnClass } from '../components/ui/Btn';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event) => {
    event.preventDefault();
    if (busy || sent) return;
    setBusy(true);
    setError('');
    try {
      await requestPasswordReset(supabase.auth, email,
        passwordRecoveryRedirect(window.location.href, import.meta.env.VITE_PUBLIC_APP_URL));
      setSent(true);
    } catch (err) {
      setError(err.message || 'Could not request a reset link. Please try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="min-h-screen flex items-center justify-center bg-neutral-50 dark:bg-charcoal-900 px-5 py-10">
      <div className="w-full max-w-md space-y-5">
        <div className="text-center space-y-2">
          <KeyRound size={30} className="mx-auto text-brand-ink" />
          <h1 className="text-xl font-bold text-neutral-900 dark:text-white">Reset your password</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Enter your sign-in email. We’ll request a link so you can choose a new password.</p>
        </div>
        <form onSubmit={submit} className="premium-card space-y-4">
          <label className="block space-y-2 text-sm text-neutral-700 dark:text-neutral-200">
            <span className="font-semibold">Email address</span>
            <input type="email" required autoComplete="email" autoFocus value={email}
              disabled={busy || sent} onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-brand/30" />
          </label>
          {sent && <p role="status" className="text-sm text-brand-ink">{RESET_REQUEST_MESSAGE}</p>}
          {error && <p role="alert" className="text-sm text-red-600 dark:text-red-300">{error}</p>}
          {!isSupabaseConfigured && <p role="alert" className="text-sm text-red-600">Authentication is not configured on this installation.</p>}
          <button type="submit" disabled={busy || sent || !isSupabaseConfigured} className={btnClass('primary', 'lg') + ' w-full'}>
            {busy && <Loader2 size={16} className="animate-spin" />}{sent ? 'Link requested' : 'Send reset link'}
          </button>
        </form>
        <Link to="/login" className="flex justify-center items-center gap-2 text-sm font-semibold text-brand-ink"><ArrowLeft size={15} /> Back to sign in</Link>
      </div>
    </main>
  );
}
