import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// HashRouter (not BrowserRouter): the native webview serves from a local origin where
// history/path routing is fragile — hash routes work identically on web and in Capacitor.
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Loader2, ShieldAlert, LogOut, RefreshCw } from 'lucide-react';
import './index.css';
import App from './App.jsx';
import Login from './pages/Login.jsx';
import { AuthProvider, useAuth } from './auth/AuthContext.jsx';
import { initNative } from './mobile/native';

initNative();

// Apply the saved theme before first paint (App owns the toggle, but login/loader render outside it).
if (localStorage.getItem('theme') !== 'light') {
  document.documentElement.classList.add('dark');
}

// Live-ish by default: Realtime (src/lib/realtime.js) pushes instant updates, and these options
// guarantee the visible screen keeps itself fresh even if the Realtime socket is unavailable.
// refetchIntervalInBackground:true is important on mobile — Capacitor webviews often don't report
// window "focus", which would otherwise pause both the poll and focus-refetch, so the phone would
// never auto-update. Forcing background polling makes the open screen refresh regardless.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      refetchOnMount: 'always',
      refetchInterval: 5_000,
      refetchIntervalInBackground: true,
    },
  },
});

function FullScreenLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-50 dark:bg-charcoal-900 text-gold-500">
      <Loader2 size={28} className="animate-spin" />
    </div>
  );
}

// Shown to a signed-in user who has no role yet (and isn't a super admin): a session alone grants
// nothing — access requires at least one role assignment, provisioned in Administration.
function NoAccess() {
  const { user, signOut, reloadAccess, accessLoading } = useAuth();
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-neutral-50 dark:bg-charcoal-900 text-center px-6">
      <div className="w-14 h-14 rounded-2xl bg-amber-100 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 flex items-center justify-center mb-5">
        <ShieldAlert size={26} />
      </div>
      <h1 className="text-lg font-bold text-neutral-900 dark:text-warm-gray-100">You're not authorized yet</h1>
      <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-2 max-w-sm leading-relaxed">
        Your account{user?.email ? <> (<span className="font-mono">{user.email}</span>)</> : ''} is signed in, but
        hasn't been assigned a role. Ask an administrator to grant you access in
        <span className="font-semibold"> Administration → Users &amp; Access</span>.
      </p>
      <div className="flex items-center gap-2.5 mt-6">
        <button
          onClick={reloadAccess}
          disabled={accessLoading}
          className="inline-flex items-center gap-2 px-4 py-2 bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300 text-xs font-semibold rounded-xl cursor-pointer hover:bg-neutral-200 dark:hover:bg-neutral-800 disabled:opacity-60"
        >
          <RefreshCw size={14} className={accessLoading ? 'animate-spin' : ''} /> Check again
        </button>
        <button
          onClick={signOut}
          className="inline-flex items-center gap-2 px-4 py-2 bg-black dark:bg-gold-450 dark:text-charcoal-900 text-white text-xs font-semibold rounded-xl cursor-pointer hover:opacity-90"
        >
          <LogOut size={14} /> Sign out
        </button>
      </div>
    </div>
  );
}

// Gate the app behind resolved access: a signed-in user needs a role (or super admin) to enter.
function AuthedApp() {
  const { access, isSuperAdmin, assignments } = useAuth();
  if (access === null) return <FullScreenLoader />; // access still resolving
  const hasAccess = isSuperAdmin || (assignments?.length ?? 0) > 0;
  return hasAccess ? <App /> : <NoAccess />;
}

// Top-level auth gate: unauthenticated users only ever see /login.
function RootRoutes() {
  const { session, loading } = useAuth();
  if (loading) return <FullScreenLoader />;
  return (
    <Routes>
      <Route path="/login" element={session ? <Navigate to="/" replace /> : <Login />} />
      <Route path="/*" element={session ? <AuthedApp /> : <Navigate to="/login" replace />} />
    </Routes>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <AuthProvider>
          <RootRoutes />
        </AuthProvider>
      </HashRouter>
    </QueryClientProvider>
  </StrictMode>
);
