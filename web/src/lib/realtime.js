// Live sync: subscribe to Supabase Realtime (Postgres changes) and invalidate the matching
// React Query caches so every signed-in device updates the instant data changes — no manual reload.
// RLS still applies to Realtime, so each user only receives changes to rows they may see (e.g. an
// employee gets the INSERT for a task assigned to them). Requires the tables to be in the
// `supabase_realtime` publication — see migration 0022.
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from './supabaseClient';
import { useAuth } from '../auth/AuthContext';

// public table → query-key prefixes to invalidate when it changes. A prefix invalidates every
// query whose key starts with it (e.g. ['attendance'] covers ['attendance','day',date]).
const TABLE_KEYS = {
  notifications: [['notifications']],
  tasks: [['tasks']],
  leaves: [['leaves']],
  expenses: [['expenses']],
  attendance: [['attendance']],
  // Punches invalidate ONLY the punch drill-down. They used to also invalidate ['attendance'],
  // which meant every punch re-pulled the (large) attendance queries on every connected admin's
  // screen — during the morning rush that is a refetch per person walking in. Attendance is
  // derived from punches by the engine, and the engine's own write emits an `attendance` event.
  raw_punches: [['punches']],
  tickets: [['tickets']],
  assets: [['assets']],
  employees: [['employees']],
  documents: [['documents']],
  exits: [['exits']],
  onboarding: [['onboarding']],
  role_assignments: [['managed-users']],
  roles: [['roles'], ['roles-with-perms']],
  role_permissions: [['roles'], ['roles-with-perms']],
  profiles: [['managed-users']],
  entities: [['org']],
  zones: [['org']],
  branches: [['org']],
  departments: [['org']],
  designations: [['org']],
};

export function useRealtimeSync() {
  const qc = useQueryClient();
  const { session } = useAuth();

  useEffect(() => {
    if (!session) return undefined;

    // Authenticate the Realtime socket so RLS scopes the change stream to this user.
    supabase.realtime.setAuth(session.access_token);

    // Coalesce bursts: the engine rewrites every employee's row on each recompute, which arrives
    // as hundreds of events within a second. Invalidating per event would fire hundreds of
    // refetch checks; collecting them and flushing once collapses that into one pass.
    let pending = new Set();
    let flushTimer = null;
    const flush = () => {
      flushTimer = null;
      const keys = [...pending];
      pending = new Set();
      for (const serialized of keys) {
        qc.invalidateQueries({ queryKey: JSON.parse(serialized), type: 'active' });
      }
    };
    const queueInvalidation = (keys) => {
      for (const key of keys) pending.add(JSON.stringify(key));
      if (!flushTimer) flushTimer = setTimeout(flush, 1_000);
    };

    const channel = supabase.channel('app-live-sync');
    for (const [table, keys] of Object.entries(TABLE_KEYS)) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => {
        queueInvalidation(keys);
      });
    }

    channel.subscribe((status) => {
      // On (re)connect — including after the app returns from background — refresh what is on
      // screen. `type: 'active'` limits it to mounted queries; a bare invalidateQueries() also
      // re-fetched every cached-but-unmounted screen, which on a phone that switches network a
      // few dozen times a day was the single largest source of traffic.
      if (status === 'SUBSCRIBED') qc.invalidateQueries({ type: 'active' });
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        // Surfaced so a misconfigured publication / blocked socket is visible in the console rather
        // than failing silently. The polling fallback (QueryClient options) keeps the UI fresh.
        console.warn('[realtime] channel status:', status, '— falling back to polling');
      }
    });

    // Webview visibility is unreliable in the native app, so refresh the visible screen when the
    // page comes back. Only `visibilitychange` — React Query's own refetchOnWindowFocus already
    // covers "focus", and listening to both meant every app switch refreshed twice.
    const refreshVisible = () => {
      if (document.visibilityState === 'visible') qc.invalidateQueries({ type: 'active' });
    };
    document.addEventListener('visibilitychange', refreshVisible);

    return () => {
      if (flushTimer) clearTimeout(flushTimer);
      supabase.removeChannel(channel);
      document.removeEventListener('visibilitychange', refreshVisible);
    };
  }, [session, qc]);
}
