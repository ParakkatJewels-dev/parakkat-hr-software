// Recovery URLs must not contain a hash route: Supabase uses the fragment for its tokens.
export function passwordRecoveryRedirect(currentUrl, publicAppUrl) {
  const url = new URL(publicAppUrl || currentUrl);
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error('Password recovery needs a web address. Configure VITE_PUBLIC_APP_URL for the mobile app.');
  }
  url.search = '?auth=recovery';
  url.hash = '';
  return url.href;
}

export function isRecoveryUrl(href) {
  const url = new URL(href);
  return url.searchParams.get('auth') === 'recovery'
    || new URLSearchParams(url.hash.slice(1)).get('type') === 'recovery';
}

export async function requestPasswordReset(auth, email, redirectTo) {
  const clean = String(email ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) throw new Error('Enter a valid email address.');
  const { error } = await auth.resetPasswordForEmail(clean, { redirectTo });
  if (error) throw error;
}

export const RESET_REQUEST_MESSAGE = 'If this email has an account, a password reset link has been requested. Check the inbox and spam folder.';

const RECOVERY_KEY = 'parakkat-password-recovery';
export function recoveryUser() {
  try { return sessionStorage.getItem(RECOVERY_KEY); } catch { return null; }
}
export function rememberRecovery(userId) {
  try {
    if (userId) sessionStorage.setItem(RECOVERY_KEY, userId);
    else sessionStorage.removeItem(RECOVERY_KEY);
  } catch { /* The current tab still works without storage. */ }
}

export function clearRecoveryUrl() {
  const url = new URL(window.location.href);
  if (url.searchParams.get('auth') === 'recovery') url.searchParams.delete('auth');
  url.hash = '/';
  window.history.replaceState(null, '', url);
}
