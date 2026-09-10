// Global auth + access context.
// Holds the Supabase session and the current user's scoped access (roles/permissions/employee),
// fetched via the get_my_access() RPC. Screens read this instead of the old cosmetic role toggle.
import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { supabase } from '../lib/supabaseClient';
import { createAccessLoader } from '../lib/accessLoader';
import { isRecoveryUrl, recoveryUser, rememberRecovery, clearRecoveryUrl } from '../lib/passwordRecovery';

// Capture before Supabase consumes the URL fragment. A URL marker alone never authorizes a reset.
const arrivedForRecovery = typeof window !== 'undefined' && isRecoveryUrl(window.location.href);

export const AuthContext = createContext(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [accessState, setAccessState] = useState({ userId: null, data: null, error: null, loading: false });
  const [sessionError, setSessionError] = useState(null);
  const [recoveryId, setRecoveryId] = useState(recoveryUser);
  const [recoveryRequested, setRecoveryRequested] = useState(arrivedForRecovery);
  const [loading, setLoading] = useState(true); // initial session resolution
  const loader = useMemo(() => createAccessLoader(() => supabase.rpc('get_my_access'), setAccessState), []);
  const loadAccess = useCallback(() => loader.load(), [loader]);
  const access = accessState.userId === session?.user?.id ? accessState.data : null;
  const finishRecovery = useCallback(() => {
    rememberRecovery(null);
    setRecoveryId(null);
    setRecoveryRequested(false);
    clearRecoveryUrl();
  }, []);

  // Resolve the current session on mount and subscribe to auth changes.
  useEffect(() => {
    let active = true;
    let receivedEvent = false;
    const accept = (s) => {
      loader.setUser(s?.user?.id ?? null);
      setSession(s ?? null);
      setSessionError(null);
      setLoading(false);
    };
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (!active) return;
      receivedEvent = true;
      if (event === 'PASSWORD_RECOVERY' && s?.user) {
        rememberRecovery(s.user.id);
        setRecoveryId(s.user.id);
        setRecoveryRequested(true);
      } else if (event === 'SIGNED_OUT') {
        finishRecovery();
      } else if (recoveryUser() && recoveryUser() !== s?.user?.id) {
        rememberRecovery(null);
        setRecoveryId(null);
      }
      accept(s);
    });
    supabase.auth.getSession().then(({ data, error }) => {
      if (!active || receivedEvent) return;
      if (error) throw error;
      accept(data.session);
    }).catch((err) => {
      if (!active || receivedEvent) return;
      setSessionError(err);
      setLoading(false);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
      loader.setUser(null);
    };
  }, [loader, finishRecovery]);

  // Whenever the session changes, (re)load the user's access profile.
  useEffect(() => {
    if (session) {
      loadAccess();
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
      // An override added or removed has to repaint the sidebar at once, the same as a role change.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'user_screen_overrides', filter: `user_id=eq.${userId}` }, refreshSoon)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'roles' }, refreshSoon)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'role_permissions' }, refreshSoon)
      .subscribe();

    // Deletes / a disconnected realtime socket must not leave access stale indefinitely.
    const refreshOnFocus = () => { if (document.visibilityState === 'visible') refreshSoon(); };
    window.addEventListener('focus', refreshOnFocus);
    document.addEventListener('visibilitychange', refreshOnFocus);
    window.addEventListener('app:access-changed', refreshSoon);
    const poll = setInterval(refreshOnFocus, 60_000);

    return () => {
      if (timer) clearTimeout(timer);
      clearInterval(poll);
      window.removeEventListener('focus', refreshOnFocus);
      document.removeEventListener('visibilitychange', refreshOnFocus);
      window.removeEventListener('app:access-changed', refreshSoon);
      supabase.removeChannel(channel);
    };
  }, [session?.user?.id, session?.access_token, loadAccess]);

  const signIn = useCallback(
    (email, password) => supabase.auth.signInWithPassword({ email: email.trim(), password }),
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
    // Screens an administrator has taken out of THIS person's sidebar (0109). Narrows only.
    hiddenScreens: access?.hidden_screens ?? [],
    // Still on the password they were provisioned with (0111). Cleared by a database trigger when
    // the password actually changes, so this cannot say "done" while the old one still works.
    mustChangePassword: Boolean(access?.must_change_password),
    // Seniority ceiling (migration 0044). You may only grant roles ranked strictly below this.
    // Mirrors app.max_role_rank(); the database still enforces it — this only shapes the UI.
    rank: access?.rank ?? 0,
    loading,
    accessLoading: accessState.loading,
    accessError: accessState.userId === session?.user?.id ? accessState.error : null,
    sessionError,
    passwordRecovery: Boolean(session?.user?.id && recoveryId === session.user.id),
    recoveryRequested,
    finishRecovery,
    signIn,
    signOut,
    reloadAccess: loadAccess,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
