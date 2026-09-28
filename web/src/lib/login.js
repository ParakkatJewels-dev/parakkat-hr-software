// Normalize the account identifier only. Spaces and letter case can be part of a password.
export function loginCredentials(formData) {
  return {
    email: String(formData.get('email') ?? '').trim().toLowerCase(),
    password: String(formData.get('password') ?? ''),
  };
}

export function signInWithEmail(auth, email, password) {
  return auth.signInWithPassword({ email: String(email ?? '').trim().toLowerCase(), password });
}

export function loginErrorMessage(error) {
  if (error?.code === 'invalid_credentials' || error?.message === 'Invalid login credentials') {
    return 'The work email or password is incorrect. Use the login email given by HR and your latest password. If it was reset, use the latest temporary password.';
  }
  if (error?.status === 429 || ['over_request_rate_limit', 'over_email_send_rate_limit'].includes(error?.code)) {
    return 'Too many sign-in attempts. Wait a few minutes, then try again.';
  }
  if (error?.code === 'email_not_confirmed') {
    return 'This login email has not been confirmed. Ask HR to check your account.';
  }
  if (error?.code === 'user_banned') {
    return 'This account is disabled. Contact HR to check your access.';
  }
  if (error?.name === 'AuthRetryableFetchError' || error instanceof TypeError || error?.status >= 500) {
    return 'The sign-in service could not be reached. Check your connection and try again shortly.';
  }
  return 'Sign in could not be completed. Please try again. If it continues, contact HR.';
}

// A reused login keeps its password. Never present a proposed password as one that was saved.
// Inspect grant.created too so older provisioning RPCs cannot display a fabricated credential.
export function loginHandover(result, { name, password } = {}) {
  if (!result?.email) return null;
  const created = result.created === true && result.grant?.created !== false;
  return { name, email: result.email, created, password: created ? (result.password ?? password ?? null) : null };
}
