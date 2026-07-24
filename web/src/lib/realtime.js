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
  tasks: [['tasks']],
  leaves: [['leaves']],
  expenses: [['expenses']],
  attendance: [['attendance']],
  punches: [['attendance'], ['punches']],
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

    const channel = supabase.channel('app-live-sync');
    for (const [table, keys] of Object.entries(TABLE_KEYS)) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => {
        for (const key of keys) qc.invalidateQueries({ queryKey: key });
      });
    }

    channel.subscribe((status) => {
      // On (re)connect — including after the app returns from background — pull everything fresh so
      // no change is missed while the socket was down.
      if (status === 'SUBSCRIBED') qc.invalidateQueries();
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        // Surfaced so a misconfigured publication / blocked socket is visible in the console rather
        // than failing silently. The polling fallback (QueryClient options) keeps the UI fresh.
        console.warn('[realtime] channel status:', status, '— falling back to polling');
      }
    });

    // Webview focus/visibility can be unreliable in the native app, so also force a full refresh
    // whenever the page becomes visible or regains focus (e.g. returning from the background).
    const refreshAll = () => {
      if (document.visibilityState === 'visible') qc.invalidateQueries();
    };
    document.addEventListener('visibilitychange', refreshAll);
    window.addEventListener('focus', refreshAll);

    return () => {
      supabase.removeChannel(channel);
      document.removeEventListener('visibilitychange', refreshAll);
      window.removeEventListener('focus', refreshAll);
    };
  }, [session, qc]);
}
