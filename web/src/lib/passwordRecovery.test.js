import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { GoTrueClient } from '@supabase/auth-js';
import { capturePasswordRecovery, createPasswordRecoveryState, normalizedHashRoute } from './passwordRecovery.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const RECOVERY_URL = 'https://hr.example.com/?auth=recovery';
const storage = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
};
function session(userId = 'employee', sessionId = 'recovery-session', revision = 0) {
  const claims = { sub: userId, session_id: sessionId, exp: Math.floor(Date.now() / 1000) + 3600, revision };
  return {
    user: { id: userId, email: `${userId}@example.com` },
    access_token: `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`,
    refresh_token: 'test-refresh-token', token_type: 'bearer', expires_in: 3600, expires_at: claims.exp,
  };
}

async function withSdkBrowser(href, run, { existingSession, rejectUser = false } = {}) {
  const previous = { window: globalThis.window, document: globalThis.document };
  const location = new URL(href);
  globalThis.window = {
    location,
    history: { replaceState: (_state, _title, next) => { location.href = new URL(next, location).href; } },
    addEventListener() {}, removeEventListener() {},
  };
  globalThis.document = { visibilityState: 'hidden' };
  const authStorage = storage();
  const storageKey = `recovery-test-${Math.random()}`;
  if (existingSession) authStorage.setItem(storageKey, JSON.stringify(existingSession));
  const auth = new GoTrueClient({
    url: 'https://auth.example.com', storageKey, storage: authStorage,
    autoRefreshToken: false, persistSession: true, detectSessionInUrl: true,
    fetch: async (url) => {
      assert.equal(String(url), 'https://auth.example.com/user');
      return new Response(JSON.stringify(rejectUser ? { message: 'Token expired', code: 'bad_jwt' } : session().user), {
        status: rejectUser ? 401 : 200, headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  try { await run(auth, location); }
  finally {
    await auth.dispose();
    if (previous.window === undefined) delete globalThis.window; else globalThis.window = previous.window;
    if (previous.document === undefined) delete globalThis.document; else globalThis.document = previous.document;
  }
}

function callbackUrl() {
  const value = session();
  return `${RECOVERY_URL}#${new URLSearchParams({
    access_token: value.access_token, refresh_token: value.refresh_token,
    expires_in: String(value.expires_in), token_type: value.token_type, type: 'recovery',
  })}`;
}

test('SDK regression: a listener mounted after recovery only receives INITIAL_SESSION', async () => {
  await withSdkBrowser(callbackUrl(), async (auth, location) => {
    assert.equal((await auth.initialize()).error, null);
    await tick(); // The SDK has already emitted the callback before React mounts.
    const events = [];
    const { data } = auth.onAuthStateChange((event) => events.push(event));
    await tick();
    assert.deepEqual(events, ['INITIAL_SESSION']);
    assert.equal(location.hash, '');
    assert.equal((await auth.getSession()).data.session.user.id, 'employee');
    data.subscription.unsubscribe();
  });
});

test('early capture retains verified recovery for a late provider and settles before invalid-link rendering', async () => {
  const href = callbackUrl();
  const state = createPasswordRecoveryState({ href, storage: storage() });
  await withSdkBrowser(href, async (auth) => {
    const captured = capturePasswordRecovery(auth, state);
    assert.equal((await captured.ready).error, null);
    const restored = (await auth.getSession()).data.session;
    assert.deepEqual(state.snapshot(restored), { passwordRecovery: true, recoveryRequested: true });
    const { data } = auth.onAuthStateChange((event, value) => state.observe(event, value));
    await tick();
    assert.equal(state.snapshot(restored).passwordRecovery, true);
    data.subscription.unsubscribe();
    captured.unsubscribe();
  });
});

test('expired callback does not authorize resetting an existing signed-in account', async () => {
  const href = `${RECOVERY_URL}#error=access_denied&error_code=otp_expired&error_description=Expired`;
  const tab = storage();
  const old = session('admin', 'admin-session');
  createPasswordRecoveryState({ storage: tab }).observe('PASSWORD_RECOVERY', old);
  const state = createPasswordRecoveryState({ href, storage: tab });
  await withSdkBrowser(href, async (auth) => {
    const captured = capturePasswordRecovery(auth, state);
    assert.ok((await captured.ready).error);
    const current = (await auth.getSession()).data.session;
    assert.equal(current.user.id, 'admin');
    assert.deepEqual(state.snapshot(current), { passwordRecovery: false, recoveryRequested: true });
    captured.unsubscribe();
  }, { existingSession: old });
});

test('a rejected token never becomes recovery proof even with a pre-existing session', async () => {
  const href = callbackUrl();
  const state = createPasswordRecoveryState({ href, storage: storage() });
  await withSdkBrowser(href, async (auth) => {
    const captured = capturePasswordRecovery(auth, state);
    assert.ok((await captured.ready).error);
    assert.equal(state.snapshot((await auth.getSession()).data.session).passwordRecovery, false);
    captured.unsubscribe();
  }, { existingSession: session('admin', 'admin-session'), rejectUser: true });
});

test('a recovery URL marker plus an ordinary session never authorizes a reset', () => {
  const state = createPasswordRecoveryState({ href: RECOVERY_URL, storage: storage() });
  state.observe('INITIAL_SESSION', session());
  state.observe('SIGNED_IN', session());
  assert.deepEqual(state.snapshot(session()), { passwordRecovery: false, recoveryRequested: true });
});

test('verified recovery survives page reload and token refresh within the same session', () => {
  const tab = storage();
  const first = createPasswordRecoveryState({ href: RECOVERY_URL, storage: tab });
  first.observe('PASSWORD_RECOVERY', session());
  const reloaded = createPasswordRecoveryState({ href: RECOVERY_URL, storage: tab });
  reloaded.observe('INITIAL_SESSION', session());
  reloaded.observe('TOKEN_REFRESHED', session('employee', 'recovery-session', 1));
  assert.equal(reloaded.snapshot(session('employee', 'recovery-session', 1)).passwordRecovery, true);
});

test('switching accounts or signing in again as the same account invalidates old recovery proof', () => {
  for (const next of [session('other', 'other-session'), session('employee', 'new-session')]) {
    const tab = storage();
    const state = createPasswordRecoveryState({ storage: tab });
    state.observe('PASSWORD_RECOVERY', session());
    state.observe('SIGNED_IN', next);
    assert.equal(state.snapshot(next).passwordRecovery, false);
    assert.equal(state.snapshot(session()).passwordRecovery, false);
    assert.equal(createPasswordRecoveryState({ storage: tab }).snapshot(session()).passwordRecovery, false);
  }
});

test('sign-out and completed recovery clear both memory and tab storage', () => {
  for (const action of ['SIGNED_OUT', 'finish']) {
    const tab = storage();
    const state = createPasswordRecoveryState({ storage: tab });
    state.observe('PASSWORD_RECOVERY', session());
    if (action === 'finish') state.clear(); else state.observe(action, null);
    assert.deepEqual(state.snapshot(session()), { passwordRecovery: false, recoveryRequested: false });
    assert.equal(createPasswordRecoveryState({ storage: tab }).snapshot(session()).passwordRecovery, false);
  }
});

test('legacy user-only storage and malformed JWTs do not verify recovery', () => {
  const tab = storage();
  tab.setItem('parakkat-password-recovery', 'employee');
  const state = createPasswordRecoveryState({ storage: tab });
  assert.equal(state.snapshot(session()).passwordRecovery, false);
  const invalid = { ...session(), access_token: 'invalid' };
  state.observe('PASSWORD_RECOVERY', invalid);
  assert.equal(state.snapshot(invalid).passwordRecovery, false);
});

test('blocked tab storage retains the verified event in memory', () => {
  const denied = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const state = createPasswordRecoveryState({ storage: denied });
  state.observe('PASSWORD_RECOVERY', session());
  assert.equal(state.snapshot(session()).passwordRecovery, true);
  state.clear();
  assert.equal(state.snapshot(session()).passwordRecovery, false);
});

test('auth callback paths preserve PKCE/error query parameters while ordinary deep links normalize', () => {
  assert.equal(normalizedHashRoute('https://hr.example.com/forgot-password'), '/#/forgot-password');
  assert.equal(normalizedHashRoute('https://hr.example.com/tasks?mine=1'), '/#/tasks?mine=1');
  for (const href of [
    'https://hr.example.com/auth/callback?code=pkce-code',
    'https://hr.example.com/forgot-password?auth=recovery',
    'https://hr.example.com/auth/callback?error=access_denied',
    callbackUrl(), 'https://hr.example.com/#/login',
  ]) assert.equal(normalizedHashRoute(href), null);
});
