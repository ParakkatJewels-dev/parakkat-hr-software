// Server-only: the /api/google/* endpoints behind Work Ledger's Google Calendar connection.
//   start      POST, signed in  → { url } to Google's consent screen; sets a sealed state cookie
//   callback   GET from Google  → stores the sealed refresh token, then back to Ledger settings
//   sync       POST, signed in  → pushes pending reminders to the calendar
//   events     POST, signed in  → today's and tomorrow's events for the Schedule card
//   disconnect POST, signed in  → revokes at Google and forgets the token
import {
  GoogleError, clearStateCookie, consentUrl, exchangeCode, googleEnvironment, pkcePair, readStateCookie, refreshAccess,
  revokeToken, seal, stateCookie, supabaseRpc, unseal,
} from './googleOAuth.js';
import { listEvents, syncReminders } from './googleCalendarSync.js';

const HEADERS = { 'Cache-Control': 'no-store, max-age=0', 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' };
const ACTIONS = new Set(['start', 'callback', 'sync', 'events', 'disconnect']);
const MESSAGES = {
  unconfigured: 'Google Calendar is not set up on this server yet.',
  unauthorized: 'Sign in again to connect Google Calendar.',
  reconnect: 'Google Calendar needs to be connected again.',
  failed: 'Google Calendar did not answer. Try again in a moment.',
};
const json = (status, body, extra = {}) => ({ status, headers: { ...HEADERS, ...extra }, body });
const fail = (status, code) => json(status, { error: { code, message: MESSAGES[code] ?? MESSAGES.failed } });

function header(request, name) {
  if (typeof request.headers?.get === 'function') return request.headers.get(name);
  const entry = Object.entries(request.headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return entry?.[1];
}
function userJwt(request) {
  const match = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(String(header(request, 'authorization') ?? '').trim());
  return match && match[1].length <= 4096 ? match[1] : null;
}
function actionOf(request) {
  const fromQuery = request.query?.action;
  if (typeof fromQuery === 'string') return fromQuery;
  try { return new URL(request.url, 'https://gateway.invalid').pathname.split('/').filter(Boolean).at(-1); } catch { return null; }
}
const istToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

export async function handleGoogleRequest(request, { environment = {}, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const action = actionOf(request);
  if (!ACTIONS.has(action)) return fail(404, 'failed');
  const google = googleEnvironment(environment);
  if (!google || typeof fetchImpl !== 'function') {
    return action === 'callback' ? { status: 302, headers: { ...HEADERS, Location: '/#/ledger/settings?google=unavailable' }, body: null } : fail(503, 'unconfigured');
  }
  const back = (state) => ({ status: 302, headers: { ...HEADERS, Location: `${google.appOrigin}/#/ledger/settings?google=${state}`,
    'Set-Cookie': clearStateCookie() }, body: null });

  if (action === 'callback') {
    if (request.method !== 'GET') return fail(405, 'failed');
    const params = new URL(request.url, google.appOrigin).searchParams;
    const state = readStateCookie(google.key, header(request, 'cookie'), now());
    if (params.get('error')) return back('cancelled');
    if (!state || params.get('state') !== state.nonce || !params.get('code')) return back('expired');
    try {
      const tokens = await exchangeCode({ fetchImpl, clientId: google.clientId, clientSecret: google.clientSecret,
        redirectUri: google.redirectUri, code: params.get('code'), verifier: state.verifier });
      // The primary calendar's id is the account's email address.
      const calendar = await fetchImpl('https://www.googleapis.com/calendar/v3/calendars/primary', {
        headers: { Authorization: `Bearer ${tokens.accessToken}` }, redirect: 'error' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      await supabaseRpc({ fetchImpl, supabase: google.supabase, name: 'ledger_google_complete', args: {
        _nonce: state.nonce, _owner: state.owner, _email: typeof calendar?.id === 'string' ? calendar.id : null,
        _ciphertext: seal(google.key, tokens.refreshToken, state.owner), _client_kind: google.clientKind } });
      return back('connected');
    } catch (error) {
      return back(error?.code === 'scope_denied' ? 'scope' : 'failed');
    }
  }

  if (request.method !== 'POST') return fail(405, 'failed');
  const jwt = userJwt(request);
  if (!jwt) return fail(401, 'unauthorized');
  const rpc = (name, args) => supabaseRpc({ fetchImpl, supabase: google.supabase, name, args, userJwt: jwt });
  try {
    if (action === 'start') {
      const begun = await rpc('ledger_google_begin', {});
      const { verifier, challenge } = pkcePair();
      return json(200, { url: consentUrl({ clientId: google.clientId, redirectUri: google.redirectUri, state: begun.nonce, challenge }) },
        { 'Set-Cookie': stateCookie(google.key, { nonce: begun.nonce, verifier, owner: begun.owner, expires: now() + 600_000 }) });
    }
    const steps = {
      fetchImpl, google,
      getSecret: () => rpc('ledger_google_secret', {}),
      getOutbox: () => rpc('ledger_calendar_outbox', {}),
      ack: (results) => rpc('ledger_calendar_ack', { _results: results }),
      markReconnect: () => rpc('ledger_google_mark', { _status: 'needs_reconnect' }),
    };
    if (action === 'sync') {
      const result = await syncReminders(steps);
      if (result.reconnect) return fail(409, 'reconnect');
      if (result.connected === false) return json(200, { connected: false });
      return json(200, { connected: true, synced: result.synced, failed: result.failed });
    }
    if (action === 'events') {
      const secret = await steps.getSecret();
      if (!secret?.ciphertext || secret.status !== 'connected') return json(200, { connected: false, events: [] });
      try {
        const accessToken = await refreshAccess({ fetchImpl, clientId: google.clientId, clientSecret: google.clientSecret,
          refreshToken: unseal(google.key, secret.ciphertext, secret.owner) });
        return json(200, { connected: true, events: await listEvents({ fetchImpl, accessToken, today: istToday() }) });
      } catch (error) {
        if (error?.code === 'invalid_grant') { await steps.markReconnect(); return fail(409, 'reconnect'); }
        throw error;
      }
    }
    // disconnect
    const secret = await steps.getSecret();
    if (secret?.ciphertext) {
      try { await revokeToken({ fetchImpl, token: unseal(google.key, secret.ciphertext, secret.owner) }); } catch { /* still forget it */ }
    }
    await rpc('ledger_google_disconnect', {});
    return json(200, { connected: false });
  } catch (error) {
    if (error instanceof GoogleError && error.status === 401) return fail(401, 'unauthorized');
    return fail(502, 'failed');
  }
}
