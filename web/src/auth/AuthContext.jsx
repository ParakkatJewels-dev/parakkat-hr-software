// Global auth + access context.
// Holds the Supabase session and the current user's scoped access (roles/permissions/employee),
// fetched via the get_my_access() RPC. Screens read this instead of the old cosmetic role toggle.
import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';

const AuthContext = createContext(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [access, setAccess] = useState(null); // { is_super_admin, employee, assignments[], permissions[] }
  const [loading, setLoading] = useState(true); // initial session resolution
  const [accessLoading, setAccessLoading] = useState(false);

  const loadAccess = useCallback(async () => {
    setAccessLoading(true);
    const { data, error } = await supabase.rpc('get_my_access');
    if (error) {
      console.error('[auth] get_my_access failed:', error.message);
      setAccess(null);
    } else {
      setAccess(data);
    }
    setAccessLoading(false);
  }, []);

  // Resolve the current session on mount and subscribe to auth changes.
  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session ?? null);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s ?? null);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  // Whenever the session changes, (re)load the user's access profile.
  useEffect(() => {
    if (session) {
      loadAccess();
    } else {
      setAccess(null);
    }
  }, [session, loadAccess]);

  // Role changes and employee-link changes affect every permission gate. Refresh the access
  // payload live so revoked/granted access does not wait for the next sign-in to take effect.
  useEffect(() => {
    const userId = session?.user?.id;
    if (!userId) return undefined;

    supabase.realtime.setAuth(session.access_token);

    let timer = null;
    const refreshSoon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(loadAccess, 250);
    };

    const channel = supabase
      .channel(`auth-access-${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'role_assignments', filter: `user_id=eq.${userId}` }, refreshSoon)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles', filter: `user_id=eq.${userId}` }, refreshSoon)
      .subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [session?.user?.id, session?.access_token, loadAccess]);

  const signIn = useCallback(
    (email, password) => supabase.auth.signInWithPassword({ email, password }),
    []
  );
  const signOut = useCallback(() => supabase.auth.signOut(), []);

  const value = {
    session,
    user: session?.user ?? null,
    access,
    employee: access?.employee ?? null,
    permissions: access?.permissions ?? [],
    assignments: access?.assignments ?? [],
    isSuperAdmin: Boolean(access?.is_super_admin),
    // Seniority ceiling (migration 0044). You may only grant roles ranked strictly below this.
    // Mirrors app.max_role_rank(); the database still enforces it — this only shapes the UI.
    rank: access?.rank ?? 0,
    loading,
    accessLoading,
    signIn,
    signOut,
    reloadAccess: loadAccess,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
