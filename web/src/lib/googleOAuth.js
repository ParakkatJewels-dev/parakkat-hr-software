// Server-only Google sign-in helpers for Work Ledger reminders. Imported by the Vercel function and
// the assistant gateway, never by the UI.
//
// No Supabase service key is involved. Refresh tokens are sealed with AES-256-GCM under
// GOOGLE_TOKEN_KEY (held only by the server) and bound to their owner, then stored in the database
// through owner-checked RPCs. The browser never sees a token, sealed or not.
import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_TIMEOUT_MS = 8000;

const base64url = (buffer) => Buffer.from(buffer).toString('base64url');

function publicProjectKey(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /\s/.test(value)) return null;
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(value)) return { key: value, jwt: false };
  try {
    const parts = value.split('.');
    if (parts.length !== 3) return null;
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return claims.role === 'anon' ? { key: value, jwt: true } : null;
  } catch { return null; }
}

/** Everything the Google flow needs, or null when the deployment is not configured for it. */
export function googleEnvironment(env = {}) {
  const key = Buffer.from(String(env.GOOGLE_TOKEN_KEY ?? ''), 'base64');
  const project = publicProjectKey(env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY);
  let supabaseOrigin, redirect;
  try {
    const url = new URL(env.SUPABASE_URL || env.VITE_SUPABASE_URL);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.pathname !== '/' || url.search || url.username) return null;
    supabaseOrigin = url.origin;
    redirect = new URL(env.GOOGLE_REDIRECT_URI);
    if (redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(redirect.hostname))) return null;
  } catch { return null; }
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || key.length !== 32 || !project) return null;
  return {
    clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, key, redirectUri: redirect.href,
    appOrigin: redirect.origin, clientKind: env.GOOGLE_CLIENT_KIND === 'external' ? 'external' : 'workspace',
    supabase: { origin: supabaseOrigin, ...project },
  };
}

/** Seal text for one owner: 'v1:' + base64url(iv | tag | ciphertext). */
export function seal(key, plaintext, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(aad)));
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `v1:${base64url(Buffer.concat([iv, cipher.getAuthTag(), body]))}`;
}

/** Open a sealed value; throws when it was sealed for someone else or tampered with. */
export function unseal(key, sealed, aad) {
  if (typeof sealed !== 'string' || !sealed.startsWith('v1:')) throw new Error('unreadable');
  const raw = Buffer.from(sealed.slice(3), 'base64url');
  if (raw.length < 29) throw new Error('unreadable');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(String(aad)));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

export function pkcePair() {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

export function consentUrl({ clientId, redirectUri, state, challenge, loginHint }) {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: GOOGLE_SCOPE,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
    code_challenge: challenge, code_challenge_method: 'S256', ...(loginHint ? { login_hint: loginHint } : {}),
  }).toString();
  return url.toString();
}

// The short-lived state cookie (nonce, PKCE verifier, owner), sealed so it cannot be read or forged.
export const STATE_COOKIE = 'ledger_google_state';
export function stateCookie(key, payload, { maxAge = 600 } = {}) {
  const value = seal(key, JSON.stringify(payload), STATE_COOKIE);
  return `${STATE_COOKIE}=${value}; Path=/api/google; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
export const clearStateCookie = () => `${STATE_COOKIE}=; Path=/api/google; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
export function readStateCookie(key, cookieHeader, now = Date.now()) {
  const match = String(cookieHeader ?? '').split(/;\s*/).find((part) => part.startsWith(`${STATE_COOKIE}=`));
  if (!match) return null;
  try {
    const payload = JSON.parse(unseal(key, match.slice(STATE_COOKIE.length + 1), STATE_COOKIE));
    return payload && typeof payload.nonce === 'string' && typeof payload.verifier === 'string' && typeof payload.owner === 'string'
      && Number(payload.expires) > now ? payload : null;
  } catch { return null; }
}

async function postForm(fetchImpl, url, form, timeoutMs = GOOGLE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
    let payload = null;
    try { payload = await response.json(); } catch { /* empty */ }
    return { ok: response.ok, status: response.status, payload };
  } finally { clearTimeout(timer); }
}

export class GoogleError extends Error {
  constructor(code, status = 502) { super(code); this.code = code; this.status = status; }
}

export async function exchangeCode({ fetchImpl, clientId, clientSecret, redirectUri, code, verifier }) {
  const result = await postForm(fetchImpl, TOKEN_URL, { grant_type: 'authorization_code', code, code_verifier: verifier,
    client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri });
  if (!result.ok || typeof result.payload?.access_token !== 'string') throw new GoogleError(result.payload?.error === 'invalid_grant' ? 'invalid_grant' : 'exchange_failed');
  if (typeof result.payload.refresh_token !== 'string') throw new GoogleError('no_refresh_token');
  if (!String(result.payload.scope ?? '').split(' ').includes(GOOGLE_SCOPE)) throw new GoogleError('scope_denied', 400);
  return { accessToken: result.payload.access_token, refreshToken: result.payload.refresh_token };
}

export async function refreshAccess({ fetchImpl, clientId, clientSecret, refreshToken }) {
  const result = await postForm(fetchImpl, TOKEN_URL, { grant_type: 'refresh_token', refresh_token: refreshToken,
    client_id: clientId, client_secret: clientSecret });
  if (result.payload?.error === 'invalid_grant') throw new GoogleError('invalid_grant', 409);
  if (!result.ok || typeof result.payload?.access_token !== 'string') throw new GoogleError('refresh_failed');
  return result.payload.access_token;
}

export async function revokeToken({ fetchImpl, token }) {
  try { await postForm(fetchImpl, REVOKE_URL, { token }); } catch { /* best effort */ }
}

/** Call a Supabase RPC as the signed-in user (their JWT) or anonymously; PostgREST checks the JWT. */
export async function supabaseRpc({ fetchImpl, supabase, name, args = {}, userJwt = null, timeoutMs = GOOGLE_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { apikey: supabase.key, 'Content-Type': 'application/json', Accept: 'application/json' };
    if (userJwt) headers.Authorization = `Bearer ${userJwt}`;
    else if (supabase.jwt) headers.Authorization = `Bearer ${supabase.key}`;
    const response = await fetchImpl(`${supabase.origin}/rest/v1/rpc/${name}`, { method: 'POST', headers, redirect: 'error',
      cache: 'no-store', signal: controller.signal, body: JSON.stringify(args) });
    let payload = null;
    try { payload = await response.json(); } catch { /* empty */ }
    if (!response.ok) throw new GoogleError(payload?.code === '42501' ? 'forbidden' : 'database', response.status === 401 ? 401 : 502);
    return payload;
  } catch (error) {
    if (error instanceof GoogleError) throw error;
    throw new GoogleError('database');
  } finally { clearTimeout(timer); }
}
