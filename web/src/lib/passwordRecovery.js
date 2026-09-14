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

function sessionIdentity(session) {
  try {
    const encoded = session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')));
    if (!session.user?.id || claims.sub !== session.user.id || !claims.session_id) return null;
    return { userId: session.user.id, sessionId: claims.session_id };
  } catch { return null; }
}

export function hasAuthCallbackParameters(href) {
  const url = new URL(href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  return ['code', 'access_token', 'refresh_token', 'error', 'error_code', 'error_description']
    .some((key) => url.searchParams.has(key) || fragment.has(key));
}

// Leave callback parameters where the SDK expects them until it has consumed the URL.
export function normalizedHashRoute(href) {
  const url = new URL(href);
  if (url.hash || isRecoveryUrl(href) || hasAuthCallbackParameters(href)) return null;
  const { pathname, search } = url;
  if (pathname === '/' || pathname === '/index.html' || pathname.includes('.') || pathname.startsWith('/api/')) return null;
  return `/#${pathname}${search}`;
}

/** Only an SDK-verified recovery event creates proof; a URL marker is just intent. */
export function createPasswordRecoveryState({ href, storage } = {}) {
  let requested = Boolean(href && isRecoveryUrl(href));
  let proof = null;
  try {
    const saved = JSON.parse(storage?.getItem(RECOVERY_KEY) ?? 'null');
    if (saved?.userId && saved?.sessionId) proof = saved;
  } catch { /* Legacy user-only marks and damaged storage cannot verify a session. */ }

  const remember = (identity) => {
    proof = identity;
    try {
      if (identity) storage?.setItem(RECOVERY_KEY, JSON.stringify(identity));
      else storage?.removeItem(RECOVERY_KEY);
    } catch { /* Keep the verified state in memory when tab storage is unavailable. */ }
  };
  // Opening a new/expired callback must not reuse proof from an earlier reset in this tab.
  if (href && hasAuthCallbackParameters(href)) remember(null);
  const matches = (session) => {
    const identity = sessionIdentity(session);
    return Boolean(proof && identity && proof.userId === identity.userId && proof.sessionId === identity.sessionId);
  };
  const clear = () => { remember(null); requested = false; };
  return {
    observe(event, session) {
      if (event === 'PASSWORD_RECOVERY') {
        remember(sessionIdentity(session));
        requested = true;
      } else if (event === 'SIGNED_OUT') {
        clear();
      } else if (proof && !matches(session)) {
        remember(null);
      }
    },
    snapshot(session) { return { passwordRecovery: matches(session), recoveryRequested: requested }; },
    reject() { remember(null); },
    clear,
  };
}

// Register immediately after createClient(), before React can mount. The SDK only replays
// INITIAL_SESSION to late subscribers, and delivers implicit PASSWORD_RECOVERY on a timer.
export function capturePasswordRecovery(auth, state) {
  const { data } = auth.onAuthStateChange((event, session) => state.observe(event, session));
  const ready = auth.initialize().then(async (result) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (result.error) state.reject();
    return result;
  });
  return { state, ready, unsubscribe: () => data.subscription.unsubscribe() };
}

export function clearRecoveryUrl() {
  const url = new URL(window.location.href);
  if (url.searchParams.get('auth') === 'recovery') url.searchParams.delete('auth');
  for (const key of ['code', 'access_token', 'refresh_token', 'error', 'error_code', 'error_description']) url.searchParams.delete(key);
  url.hash = '/';
  window.history.replaceState(null, '', url);
}
