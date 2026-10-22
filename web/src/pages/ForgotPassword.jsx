import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Info, Loader2, Mail } from 'lucide-react';
import { supabase, isSupabaseConfigured } from '../lib/supabaseClient';
import { passwordRecoveryRedirect, requestPasswordReset, RESET_REQUEST_MESSAGE } from '../lib/passwordRecovery';
import AuthLayout from './AuthLayout';

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
    <AuthLayout>
      <Link to="/login" className="mb-6 inline-flex items-center gap-2 text-sm font-semibold text-neutral-600 hover:text-neutral-900 dark:text-neutral-300"><ArrowLeft size={16} /> Back to sign in</Link>
      <h1>Reset your password</h1>
      <p className="auth-lede">Enter your work email. We’ll send a link so you can choose a new password.</p>
      <form onSubmit={submit}>
        <label className="auth-field">
          <span>Work email</span>
          <span className="auth-input-wrap">
            <Mail size={18} aria-hidden="true" />
            <input type="email" required autoComplete="email" autoFocus value={email} placeholder="name@company.com"
              disabled={busy || sent} onChange={(e) => setEmail(e.target.value)} className="auth-input" />
          </span>
        </label>
        {sent && <p role="status" className="auth-status">{RESET_REQUEST_MESSAGE}</p>}
        {error && <p role="alert" className="auth-alert">{error}</p>}
        {!isSupabaseConfigured && <p role="alert" className="auth-alert">Authentication is not configured on this installation.</p>}
        <button type="submit" disabled={busy || sent || !isSupabaseConfigured} className="auth-submit">
          {busy && <Loader2 size={18} className="animate-spin" />}{sent ? 'Link requested' : 'Send reset link'}
        </button>
      </form>
      <p className="auth-note"><Info size={17} aria-hidden="true" />The link goes to the email you enter, so check its inbox and spam folder.</p>
    </AuthLayout>
  );
}
