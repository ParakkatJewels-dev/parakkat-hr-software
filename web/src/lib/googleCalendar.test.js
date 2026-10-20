import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import {
  GOOGLE_SCOPE, consentUrl, googleEnvironment, pkcePair, readStateCookie, seal, stateCookie, unseal,
} from './googleOAuth.js';
import { applyOutbox, eventBody, eventIdFor, listEvents, recurrenceFor, syncReminders } from './googleCalendarSync.js';
import { handleGoogleRequest } from './googleGateway.js';

const KEY = randomBytes(32);
const jwt = (claims) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
const ENV = {
  SUPABASE_URL: 'https://project.example.com', SUPABASE_ANON_KEY: jwt({ role: 'anon' }),
  GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret', GOOGLE_TOKEN_KEY: KEY.toString('base64'),
  GOOGLE_REDIRECT_URI: 'https://hr.example.com/api/google/callback',
};
const OWNER = '60000000-0000-0000-0000-000000000001';
const USER_JWT = jwt({ role: 'authenticated', sub: OWNER });
const json = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('configuration needs every Google setting, a 32-byte key and a public project key', () => {
  const google = googleEnvironment(ENV);
  assert.equal(google.appOrigin, 'https://hr.example.com');
  assert.equal(google.clientKind, 'workspace');
  assert.equal(googleEnvironment({ ...ENV, GOOGLE_CLIENT_KIND: 'external' }).clientKind, 'external');
  for (const broken of [{ GOOGLE_CLIENT_ID: '' }, { GOOGLE_TOKEN_KEY: Buffer.alloc(16).toString('base64') },
    { SUPABASE_ANON_KEY: jwt({ role: 'service_role' }) }, { GOOGLE_REDIRECT_URI: 'http://hr.example.com/cb' }, { SUPABASE_URL: 'http://remote.example.com' }]) {
    assert.equal(googleEnvironment({ ...ENV, ...broken }), null, JSON.stringify(broken));
  }
});

test('sealed tokens open only for their owner and never after tampering', () => {
  const sealed = seal(KEY, 'refresh-token', OWNER);
  assert.match(sealed, /^v1:[A-Za-z0-9_-]+$/);
  assert.equal(unseal(KEY, sealed, OWNER), 'refresh-token');
  assert.throws(() => unseal(KEY, sealed, '60000000-0000-0000-0000-000000000002'), 'bound to its owner');
  assert.throws(() => unseal(randomBytes(32), sealed, OWNER), 'needs the server key');
  const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA');
  assert.throws(() => unseal(KEY, tampered, OWNER));
  assert.notEqual(seal(KEY, 'x', OWNER), seal(KEY, 'x', OWNER), 'fresh nonce every time');
});

test('the consent link asks only for calendar events, offline, with PKCE and the state', () => {
  const { verifier, challenge } = pkcePair();
  assert.ok(verifier.length >= 43 && challenge.length === 43);
  const url = new URL(consentUrl({ clientId: 'client-id', redirectUri: ENV.GOOGLE_REDIRECT_URI, state: 'nonce-1', challenge }));
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('scope'), GOOGLE_SCOPE);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'nonce-1');
});

test('the state cookie is sealed, short-lived and HttpOnly', () => {
  const cookie = stateCookie(KEY, { nonce: 'n', verifier: 'v', owner: OWNER, expires: 2000 });
  assert.match(cookie, /HttpOnly; Secure; SameSite=Lax; Max-Age=600/);
  assert.match(cookie, /Path=\/api\/google/);
  const header = cookie.split(';')[0];
  assert.deepEqual(readStateCookie(KEY, `other=1; ${header}`, 1000), { nonce: 'n', verifier: 'v', owner: OWNER, expires: 2000 });
  assert.equal(readStateCookie(KEY, header, 3000), null, 'expired');
  assert.equal(readStateCookie(randomBytes(32), header, 1000), null, 'forged');
  assert.equal(readStateCookie(KEY, 'nothing=here', 1000), null);
});

test('reminder events: 15 minutes, two pop-ups, Asia/Kolkata, and month-end safe repeats', () => {
  const body = eventBody({ text: 'Call printer', due_at: '2026-10-08T23:50', repeat: 'weekdays' });
  assert.equal(body.summary, 'Reminder: Call printer');
  assert.deepEqual(body.start, { dateTime: '2026-10-08T23:50:00', timeZone: 'Asia/Kolkata' });
  assert.deepEqual(body.end, { dateTime: '2026-10-09T00:05:00', timeZone: 'Asia/Kolkata' }, 'crosses midnight');
  assert.deepEqual(body.reminders.overrides, [{ method: 'popup', minutes: 0 }, { method: 'popup', minutes: 10 }]);
  assert.deepEqual(body.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR']);
  assert.equal(eventBody({ text: 'x', due_at: '2026-10-08T10:00' }).recurrence, undefined);
  assert.deepEqual(recurrenceFor('monthly', '2026-01-15T10:00'), ['RRULE:FREQ=MONTHLY']);
  assert.deepEqual(recurrenceFor('monthly', '2026-01-31T10:00'), ['RRULE:FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1']);
  assert.deepEqual(recurrenceFor('monthly', '2026-01-30T10:00'), ['RRULE:FREQ=MONTHLY;BYMONTHDAY=28,29,30;BYSETPOS=-1']);
  assert.match(eventIdFor('0b2c-4d'.padEnd(36, 'a')), /^ldr[0-9a-v]+$/);
  assert.equal(eventIdFor('12345678-1234-1234-1234-123456789abc'), 'ldr12345678123412341234123456789abc');
});

test('the outbox inserts, recovers from retries and missing events, deletes, and reports failures', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([options.method, url]);
    if (options.method === 'POST' && JSON.parse(options.body).summary === 'Reminder: exists') return json({}, 409);
    if (options.method === 'PATCH' && url.endsWith('gone')) return json({}, 404);
    if (options.method === 'DELETE') return json(null, url.endsWith('missing') ? 410 : 204);
    if (url.includes('broken')) return json({ error: 'x' }, 500);
    if (url.includes('throws')) throw new Error('network');
    return json({ id: options.method === 'POST' ? JSON.parse(options.body).id : url.split('/').at(-1) });
  };
  const results = await applyOutbox({ fetchImpl, accessToken: 'a', items: [
    { id: '11111111-1111-1111-1111-111111111111', op: 'insert', text: 'new', due_at: '2026-10-08T10:00' },
    { id: '22222222-2222-2222-2222-222222222222', op: 'insert', text: 'exists', due_at: '2026-10-08T10:00' },
    { id: '33333333-3333-3333-3333-333333333333', op: 'patch', event_id: 'gone', text: 'moved', due_at: '2026-10-08T10:00' },
    { id: '44444444-4444-4444-4444-444444444444', op: 'delete', event_id: 'missing' },
    { id: '55555555-5555-5555-5555-555555555555', op: 'patch', event_id: 'broken', text: 'x', due_at: '2026-10-08T10:00' },
    { id: '66666666-6666-6666-6666-666666666666', op: 'patch', event_id: 'throws', text: 'x', due_at: '2026-10-08T10:00' },
  ] });
  assert.deepEqual(results.map((r) => r.ok), [true, true, true, true, false, false]);
  assert.equal(results[0].event_id, 'ldr11111111111111111111111111111111');
  assert.ok(calls.some(([method, url]) => method === 'PATCH' && url.endsWith('ldr22222222222222222222222222222222')), 'retry becomes an update');
  assert.equal(results[4].error, 'Google said 500');
  assert.equal(results[5].error, 'Google did not answer');
});

test('the schedule leaves out our own reminder events and cancelled ones', async () => {
  let asked;
  const events = await listEvents({ today: '2026-10-08', accessToken: 'a', fetchImpl: async (url) => {
    asked = new URL(url);
    return json({ items: [
      { id: 'e1', summary: 'Design review', start: { dateTime: '2026-10-08T11:00:00+05:30' }, end: { dateTime: '2026-10-08T11:30:00+05:30' } },
      { id: 'e2', summary: 'Reminder: Call printer', start: { dateTime: '2026-10-08T10:00:00+05:30' } },
      { id: 'e3', summary: 'Holiday', start: { date: '2026-10-09' }, end: { date: '2026-10-10' } },
      { id: 'e4', summary: 'Cancelled', status: 'cancelled', start: { dateTime: '2026-10-08T12:00:00+05:30' } },
    ] });
  } });
  assert.deepEqual(events.map((e) => e.id), ['e1', 'e3']);
  assert.equal(events[1].all_day, true);
  assert.equal(asked.searchParams.get('timeMin'), '2026-10-08T00:00:00+05:30');
  assert.equal(asked.searchParams.get('timeMax'), '2026-10-09T18:30:00.000Z', 'two days, Asia/Kolkata');
});

test('sync refreshes access, applies the outbox and acknowledges; an expired grant asks to reconnect', async () => {
  const google = googleEnvironment(ENV);
  const sealed = seal(KEY, 'refresh-1', OWNER);
  let acked, marked = false;
  const fetchImpl = async (url, options) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return new URLSearchParams(options.body).get('refresh_token') === 'refresh-1' ? json({ access_token: 'access-1' }) : json({ error: 'invalid_grant' }, 400);
    }
    return json({ id: 'evt' });
  };
  const steps = (ciphertext) => ({ google, fetchImpl, getSecret: async () => ({ owner: OWNER, ciphertext, status: 'connected' }),
    getOutbox: async () => [{ id: '11111111-1111-1111-1111-111111111111', op: 'insert', text: 'x', due_at: '2026-10-08T10:00' }],
    ack: async (results) => { acked = results; }, markReconnect: async () => { marked = true; } });
  const done = await syncReminders(steps(sealed));
  assert.equal(done.synced, 1);
  assert.equal(acked[0].ok, true);
  const expired = await syncReminders(steps(seal(KEY, 'refresh-revoked', OWNER)));
  assert.deepEqual(expired, { reconnect: true });
  assert.equal(marked, true);
  assert.deepEqual(await syncReminders({ ...steps(sealed), getSecret: async () => null }), { connected: false });
});

function gatewayFetch(log) {
  return async (url, options = {}) => {
    log.push([options.method ?? 'GET', url, options]);
    if (url.endsWith('/rpc/ledger_google_begin')) return json({ nonce: 'nonce-1', owner: OWNER });
    if (url.endsWith('/rpc/ledger_google_complete')) return json(true);
    if (url.endsWith('/rpc/ledger_google_secret')) return json({ owner: OWNER, ciphertext: seal(KEY, 'refresh-1', OWNER), status: 'connected' });
    if (url.endsWith('/rpc/ledger_calendar_outbox')) return json([]);
    if (url.endsWith('/rpc/ledger_google_disconnect')) return json(null);
    if (url.includes('oauth2.googleapis.com/token')) {
      const form = new URLSearchParams(options.body);
      return form.get('grant_type') === 'authorization_code'
        ? json({ access_token: 'access-1', refresh_token: 'refresh-new', scope: `openid ${GOOGLE_SCOPE}` })
        : json({ access_token: 'access-1' });
    }
    if (url.includes('oauth2.googleapis.com/revoke')) return json({});
    if (url.endsWith('/calendars/primary')) return json({ id: 'vivek@parakkat.example' });
    if (url.includes('/calendars/primary/events')) return json({ items: [{ id: 'e1', summary: 'Shoot', start: { dateTime: '2026-10-08T11:00:00+05:30' } }] });
    return json({}, 404);
  };
}
const request = (action, { method = 'POST', headers = {}, url } = {}) => ({ method, url: url ?? `/api/google/${action}`, query: { action },
  headers: { authorization: `Bearer ${USER_JWT}`, ...headers } });

test('start needs a signed-in user and returns the consent link with a sealed state cookie', async () => {
  const log = [];
  const started = await handleGoogleRequest(request('start'), { environment: ENV, fetchImpl: gatewayFetch(log) });
  assert.equal(started.status, 200);
  assert.match(started.body.url, /^https:\/\/accounts\.google\.com/);
  assert.match(started.headers['Set-Cookie'], /^ledger_google_state=v1:/);
  assert.equal(log[0][2].headers.Authorization, `Bearer ${USER_JWT}`, 'begins as the user');
  const anonymous = await handleGoogleRequest(request('start', { headers: { authorization: '' } }), { environment: ENV, fetchImpl: gatewayFetch([]) });
  assert.equal(anonymous.status, 401);
  assert.equal((await handleGoogleRequest(request('start'), { environment: {}, fetchImpl: gatewayFetch([]) })).status, 503);
  assert.equal((await handleGoogleRequest(request('start', { method: 'GET' }), { environment: ENV, fetchImpl: gatewayFetch([]) })).status, 405);
  assert.equal((await handleGoogleRequest(request('steal'), { environment: ENV, fetchImpl: gatewayFetch([]) })).status, 404);
});

test('the callback stores the token sealed for its owner and returns to Ledger settings', async () => {
  const log = [];
  const cookie = stateCookie(KEY, { nonce: 'nonce-1', verifier: 'verifier-1', owner: OWNER, expires: Date.now() + 60_000 }).split(';')[0];
  const done = await handleGoogleRequest(request('callback', { method: 'GET', headers: { cookie, authorization: '' },
    url: '/api/google/callback?code=abc&state=nonce-1' }), { environment: ENV, fetchImpl: gatewayFetch(log) });
  assert.equal(done.status, 302);
  assert.equal(done.headers.Location, 'https://hr.example.com/#/ledger/settings?google=connected');
  assert.match(done.headers['Set-Cookie'], /Max-Age=0/);
  const exchange = log.find(([, url]) => url.includes('oauth2.googleapis.com/token'));
  assert.equal(new URLSearchParams(exchange[2].body).get('code_verifier'), 'verifier-1', 'PKCE verifier from the cookie');
  const complete = log.find(([, url]) => url.endsWith('/rpc/ledger_google_complete'));
  const args = JSON.parse(complete[2].body);
  assert.equal(args._nonce, 'nonce-1');
  assert.equal(args._email, 'vivek@parakkat.example');
  assert.equal(unseal(KEY, args._ciphertext, OWNER), 'refresh-new', 'sealed for its owner');
  assert.equal(complete[2].headers.Authorization, `Bearer ${ENV.SUPABASE_ANON_KEY}`, 'no user session on the callback');
  assert.ok(!JSON.stringify(done).includes('refresh-new'), 'the token never reaches the browser');
  for (const [query, expected] of [['code=abc&state=other', 'expired'], ['error=access_denied&state=nonce-1', 'cancelled'], ['state=nonce-1', 'expired']]) {
    const result = await handleGoogleRequest(request('callback', { method: 'GET', headers: { cookie }, url: `/api/google/callback?${query}` }), { environment: ENV, fetchImpl: gatewayFetch([]) });
    assert.match(result.headers.Location, new RegExp(`google=${expected}$`), query);
  }
  const noCookie = await handleGoogleRequest(request('callback', { method: 'GET', url: '/api/google/callback?code=abc&state=nonce-1' }), { environment: ENV, fetchImpl: gatewayFetch([]) });
  assert.match(noCookie.headers.Location, /google=expired$/);
});

test('sync, events and disconnect run as the signed-in user', async () => {
  const log = [];
  const sync = await handleGoogleRequest(request('sync'), { environment: ENV, fetchImpl: gatewayFetch(log) });
  assert.deepEqual(sync.body, { connected: true, synced: 0, failed: 0 });
  const events = await handleGoogleRequest(request('events'), { environment: ENV, fetchImpl: gatewayFetch(log) });
  assert.equal(events.body.events[0].summary, 'Shoot');
  const off = await handleGoogleRequest(request('disconnect'), { environment: ENV, fetchImpl: gatewayFetch(log) });
  assert.deepEqual(off.body, { connected: false });
  assert.ok(log.some(([, url]) => url.includes('/revoke')), 'revoked at Google');
  assert.ok(log.some(([, url]) => url.endsWith('/rpc/ledger_google_disconnect')), 'forgotten here');
  assert.ok(log.filter(([, url]) => url.includes('/rest/v1/rpc/')).every(([, , options]) => options.headers.Authorization === `Bearer ${USER_JWT}`));
});
