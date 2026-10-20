// Server-only: mirror Work Ledger reminders into the owner's primary Google Calendar, and read the
// next two days of events for the Schedule card. Shared by the Vercel function (owner's session) and
// the assistant gateway (owner's personal key).
import { GoogleError, GOOGLE_TIMEOUT_MS, refreshAccess, unseal } from './googleOAuth.js';

const CALENDAR = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const ZONE = 'Asia/Kolkata';

/** Google event ids allow 0-9 and a-v; a reminder's uuid in hex always fits. */
export const eventIdFor = (reminderId) => `ldr${String(reminderId).replace(/-/g, '').toLowerCase()}`;

const pad = (n) => String(n).padStart(2, '0');
function plusMinutes(localDateTime, minutes) {
  const [date, time] = localDateTime.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [h, min] = time.split(':').map(Number);
  const value = new Date(Date.UTC(y, m - 1, d, h, min + minutes));
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}T${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}`;
}

/** Monthly reminders on the 29th–31st land on the month's last day when the month is shorter. */
export function recurrenceFor(repeat, dueAt) {
  if (repeat === 'daily') return ['RRULE:FREQ=DAILY'];
  if (repeat === 'weekly') return ['RRULE:FREQ=WEEKLY'];
  if (repeat === 'weekdays') return ['RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'];
  if (repeat === 'monthly') {
    const day = Number(String(dueAt).slice(8, 10));
    if (day <= 28) return ['RRULE:FREQ=MONTHLY'];
    const days = Array.from({ length: day - 27 }, (_, i) => 28 + i).join(',');
    return [`RRULE:FREQ=MONTHLY;BYMONTHDAY=${days};BYSETPOS=-1`];
  }
  return undefined;
}

/** A 15-minute event titled "Reminder: …" with pop-ups at the time and ten minutes before. */
export function eventBody(item) {
  const body = {
    summary: `Reminder: ${item.text}`,
    start: { dateTime: `${item.due_at}:00`, timeZone: ZONE },
    end: { dateTime: `${plusMinutes(item.due_at, 15)}:00`, timeZone: ZONE },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }, { method: 'popup', minutes: 10 }] },
  };
  const recurrence = recurrenceFor(item.repeat, item.due_at);
  if (recurrence) body.recurrence = recurrence;
  return body;
}

async function call(fetchImpl, accessToken, url, method, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOOGLE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { method, redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    let payload = null;
    try { payload = await response.json(); } catch { /* DELETE has no body */ }
    return { status: response.status, ok: response.ok, payload };
  } finally { clearTimeout(timer); }
}

/** Apply outbox items; never throws for one item, so one failure does not block the rest. */
export async function applyOutbox({ fetchImpl, accessToken, items }) {
  const results = [];
  for (const item of items ?? []) {
    const id = item.event_id || eventIdFor(item.id);
    try {
      let result;
      if (item.op === 'delete') {
        result = await call(fetchImpl, accessToken, `${CALENDAR}/${encodeURIComponent(id)}`, 'DELETE');
        const gone = result.ok || result.status === 404 || result.status === 410;
        results.push({ id: item.id, op: 'delete', ok: gone, ...(gone ? {} : { error: `Google said ${result.status}` }) });
        continue;
      }
      if (item.op === 'insert') {
        result = await call(fetchImpl, accessToken, CALENDAR, 'POST', { id, ...eventBody(item) });
        // A retry after a lost response: the event already exists, so update it instead.
        if (result.status === 409) result = await call(fetchImpl, accessToken, `${CALENDAR}/${encodeURIComponent(id)}`, 'PATCH', eventBody(item));
      } else {
        result = await call(fetchImpl, accessToken, `${CALENDAR}/${encodeURIComponent(id)}`, 'PATCH', eventBody(item));
        if (result.status === 404 || result.status === 410) result = await call(fetchImpl, accessToken, CALENDAR, 'POST', { id: eventIdFor(item.id), ...eventBody(item) });
      }
      results.push(result.ok
        ? { id: item.id, op: item.op, ok: true, event_id: result.payload?.id ?? id }
        : { id: item.id, op: item.op, ok: false, error: `Google said ${result.status}` });
    } catch {
      results.push({ id: item.id, op: item.op, ok: false, error: 'Google did not answer' });
    }
  }
  return results;
}

/** Today's and tomorrow's events (Asia/Kolkata), without the "Reminder:" events we created. */
export async function listEvents({ fetchImpl, accessToken, today }) {
  const end = new Date(`${today}T00:00:00+05:30`);
  end.setUTCDate(end.getUTCDate() + 2);
  const url = new URL(CALENDAR);
  url.search = new URLSearchParams({ timeMin: `${today}T00:00:00+05:30`, timeMax: end.toISOString(), singleEvents: 'true',
    orderBy: 'startTime', maxResults: '50', timeZone: ZONE }).toString();
  const result = await call(fetchImpl, accessToken, url.toString(), 'GET');
  if (result.status === 401) throw new GoogleError('invalid_grant', 409);
  if (!result.ok) throw new GoogleError('calendar_failed');
  return (result.payload?.items ?? [])
    .filter((event) => event.status !== 'cancelled' && !String(event.summary ?? '').startsWith('Reminder:'))
    .map((event) => ({ id: event.id, summary: event.summary ?? '(no title)', start: event.start?.dateTime ?? event.start?.date,
      end: event.end?.dateTime ?? event.end?.date, all_day: Boolean(event.start?.date && !event.start?.dateTime), link: event.htmlLink ?? null }));
}

/**
 * The whole sync, with the storage steps injected so the owner's session and the assistant key can
 * both drive it: fetch the sealed token, refresh access, apply the outbox, acknowledge.
 * Returns { synced, failed } or { connected: false } / { reconnect: true }.
 */
export async function syncReminders({ google, fetchImpl, getSecret, getOutbox, ack, markReconnect }) {
  const secret = await getSecret();
  if (!secret?.ciphertext || !secret.owner || secret.status !== 'connected') return { connected: false };
  let accessToken;
  try {
    accessToken = await refreshAccess({ fetchImpl, clientId: google.clientId, clientSecret: google.clientSecret,
      refreshToken: unseal(google.key, secret.ciphertext, secret.owner) });
  } catch (error) {
    if (error?.code === 'invalid_grant') { await markReconnect?.(); return { reconnect: true }; }
    if (error instanceof GoogleError) throw error;
    throw new GoogleError('unreadable_token');
  }
  const items = await getOutbox();
  if (!items?.length) return { synced: 0, failed: 0, accessToken };
  const results = await applyOutbox({ fetchImpl, accessToken, items });
  await ack(results);
  return { synced: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, accessToken };
}
