// Login screen. Guards the entire app: no session -> this is all you can see.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Eye, EyeOff, Info, Loader2, Lock, Mail } from 'lucide-react';
import AuthLayout from './AuthLayout';
import { useAuth } from '../auth/AuthContext';
import { isSupabaseConfigured } from '../lib/supabaseClient';
import { loginCredentials, loginErrorMessage } from '../lib/login';

function LoginField({ icon: Icon, label, children }) {
  return (
    <label className="auth-field">
      <span>{label}</span>
      <span className="auth-input-wrap">
        <Icon size={18} aria-hidden="true" />
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
    if (busy) return;
    // Read the actual fields so browser/password-manager autofill is used even without a change event.
    const credentials = loginCredentials(new FormData(e.currentTarget));
    setEmail(credentials.email);
    setPassword(credentials.password);
    setError('');
    setBusy(true);
    try {
      const { error: err } = await signIn(credentials.email, credentials.password);
      if (err) throw err;
    } catch (err) {
      setError(loginErrorMessage(err));
    } finally { setBusy(false); }
    // On success, the auth listener flips the session and the router shows the app.
  };

  return (
    <AuthLayout>
      <h1>Welcome back</h1>
      <p className="auth-lede">Sign in to your Parakkat HRMS account.</p>

      {!isSupabaseConfigured && (
        <p className="auth-alert flex items-start gap-2">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span>Backend not configured. Add Supabase keys to <code>.env.local</code>.</span>
        </p>
      )}

      <form onSubmit={onSubmit}>
        <LoginField icon={Mail} label="Work email">
          <input
            type="email"
            name="email"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@company.com"
            className="auth-input"
          />
        </LoginField>

        <LoginField icon={Lock} label="Password">
          <input
            type={showPassword ? 'text' : 'password'}
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter password"
            className="auth-input has-toggle"
          />
          <button
            type="button"
            onClick={() => setShowPassword((value) => !value)}
            className="auth-input-toggle"
            aria-label={showPassword ? 'Hide password' : 'Show password'}
          >
            {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        </LoginField>

        <div className="-mt-1 mb-5 text-right">
          <Link to="/forgot-password" className="auth-link">Forgot password?</Link>
        </div>

        {error && <p role="alert" className="auth-alert">{error}</p>}

        <button type="submit" disabled={busy} className="auth-submit">
          {busy ? <Loader2 size={18} className="animate-spin" /> : null}
          {busy ? 'Signing in…' : 'Sign in'}
          {!busy && <ArrowRight size={19} aria-hidden="true" />}
        </button>
      </form>

      <p className="auth-note">
        <Info size={17} aria-hidden="true" />
        Your branch and department access will apply after sign in.
      </p>
    </AuthLayout>
  );
}
