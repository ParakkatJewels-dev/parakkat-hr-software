// Reminders' Google Calendar link. It goes through the server (/api/google/*), carrying the user's own
// session token; the refresh token is sealed on the server and never reaches the browser.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { supabase } from '../lib/supabaseClient';

export const calendarKeys = {
  root: ['calendar'],
  status: () => ['calendar', 'status'],
  events: () => ['calendar', 'events'],
};

export const newId = () => globalThis.crypto.randomUUID();

async function googleCall(action) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Sign in again to use Google Calendar.');
  const response = await fetch(`/api/google/${action}`, { method: 'POST', headers: { Authorization: `Bearer ${session.access_token}` }, credentials: 'same-origin' });
  let body = null;
  try { body = await response.json(); } catch { /* empty */ }
  if (response.status === 409) return { reconnect: true };
  if (!response.ok) throw new Error(body?.error?.message ?? 'Google Calendar did not answer. Try again in a moment.');
  return body;
}

export async function connectGoogleCalendar() {
  const { url } = await googleCall('start');
  window.location.assign(url);
}
export const syncGoogleCalendar = () => googleCall('sync');
export const disconnectGoogleCalendar = () => googleCall('disconnect');

export function useGoogleStatus() {
  const { user } = useAuth();
  return useQuery({ queryKey: calendarKeys.status(), enabled: Boolean(user?.id), meta: { persist: false },
    queryFn: async () => {
      const { data, error } = await supabase.rpc('ledger_google_status', {});
      if (error) throw error;
      return data;
    } });
}

export function useGoogleEvents(enabled) {
  return useQuery({ queryKey: calendarKeys.events(), enabled: Boolean(enabled), meta: { persist: false }, staleTime: 5 * 60_000, retry: false,
    queryFn: () => googleCall('events') });
}

/** After connecting or disconnecting: the status, today's events and Home's schedule. */
export function useRefreshCalendar() {
  const client = useQueryClient();
  return () => Promise.all([calendarKeys.root, ['work']].map((queryKey) => client.invalidateQueries({ queryKey })));
}
