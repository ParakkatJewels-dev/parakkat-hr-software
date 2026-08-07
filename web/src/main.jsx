import { Component, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// HashRouter (not BrowserRouter): the native webview serves from a local origin where
// history/path routing is fragile — hash routes work identically on web and in Capacitor.
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import { supabase } from './lib/supabaseClient';
import { Loader2, ShieldAlert, LogOut, RefreshCw } from 'lucide-react';
import './index.css';
import App from './App.jsx';
import Login from './pages/Login.jsx';
import { AuthProvider, useAuth } from './auth/AuthContext.jsx';
import { initNative } from './mobile/native';
import { installPreloadErrorHandler, registerServiceWorker } from './lib/pwa';

function normalizeHashRoute() {
  const { pathname, search, hash } = window.location;
  const cleanAppPath =
    pathname !== '/' &&
    pathname !== '/index.html' &&
    !pathname.includes('.') &&
    !pathname.startsWith('/api/');

  if (!hash && cleanAppPath) {
    window.history.replaceState(null, '', `/#${pathname}${search}`);
  }
}

normalizeHashRoute();
initNative();
installPreloadErrorHandler();
registerServiceWorker();

// Apply the saved theme before first paint (App owns the toggle, but login/loader render outside it).
if (localStorage.getItem('theme') === 'dark') {
  document.documentElement.classList.add('dark');
}

// Realtime (src/lib/realtime.js) is the push channel — it invalidates the exact caches that
// changed, so polling only needs to be a safety net for a dropped socket.
//
// This used to poll EVERY query every 5s, in the background. Measured cost at this company's size
// (264 staff): an entity admin's dashboard alone is 22 requests per cycle, so ~40 signed-in users
// generated roughly 100 PostgREST requests per second, around the clock, including the 1-2 MB
// attendance-exceptions query. A 5-minute net keeps the mobile guarantee the original comment
// cared about (Capacitor webviews under-report "focus") at 1/60th the traffic; screens that truly
// need to tick faster set their own interval (useDayAttendance, the sync-status hooks).
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      refetchOnMount: true,
      refetchInterval: 300_000,
      refetchIntervalInBackground: false,
      // Restored cache is only useful if the queries that read it will accept it. Anything older
      // than this is refetched rather than shown.
      gcTime: 24 * 60 * 60_000,
    },
  },
});

// --- surviving a refresh ----------------------------------------------------------------------
// Without this the whole cache dies on every reload: the sync card, the roster, the day's
// attendance all render empty and refetch from zero, which on a slow connection is several seconds
// of blank screen for data that was on screen a moment ago. Persisting it means a refresh paints
// the previous answer immediately and revalidates behind it.
//
// The version string is the safety catch. Restoring a cache whose shape no longer matches the code
// reading it is worse than having no cache, so any change to the queries bumps this and every
// stored cache is discarded.
const CACHE_VERSION = 'v1';
const CACHE_KEY = 'parakkat-hr-cache';

/**
 * localStorage, but a damaged or unreadable cache can never stop the app starting.
 *
 * The persister's restore does a bare JSON.parse, so a truncated entry — a tab killed mid-write,
 * a full storage quota, a half-finished write on a laptop that lost power — throws during startup
 * and the app renders nothing. There is no way out of that for the user except clearing site data,
 * which nobody in an HR office is going to work out. So a value that will not parse is treated as
 * absent and deleted, and the app carries on and refetches.
 *
 * Storage being unavailable entirely (private browsing, a locked-down policy) is handled the same
 * way: no persistence, everything else works.
 */
const safeStorage = {
  getItem: (key) => {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return null;
      JSON.parse(raw); // validate before handing it over
      return raw;
    } catch {
      try { window.localStorage.removeItem(key); } catch { /* nothing to clean up */ }
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Quota exceeded, most likely. Losing the cache is not worth failing a render over.
    }
  },
  removeItem: (key) => {
    try { window.localStorage.removeItem(key); } catch { /* already gone */ }
  },
};

const persister = createSyncStoragePersister({
  storage: safeStorage,
  key: CACHE_KEY,
  // A write per query result would thrash localStorage during the morning rush; batch them.
  throttleTime: 2_000,
});

// One user's cached attendance must never be shown to the next person to sign in on this machine —
// a shared HR laptop is exactly the situation this app is deployed into. The cache is therefore
// keyed by user, and torn down the moment the signed-in identity changes.
let cachedUserId = null;
supabase.auth.onAuthStateChange((event, session) => {
  const uid = session?.user?.id ?? null;
  if (event === 'SIGNED_OUT' || (cachedUserId && uid && uid !== cachedUserId)) {
    queryClient.clear();
    try {
      window.localStorage.removeItem(CACHE_KEY);
    } catch {
      // A browser with storage disabled simply has nothing to clear.
    }
  }
  cachedUserId = uid;
});

function FullScreenLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-50 dark:bg-charcoal-900 text-[#0ea971]">
      <Loader2 size={28} className="animate-spin" />
    </div>
  );
}

function FullScreenError({ error }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-neutral-50 dark:bg-charcoal-900 text-center px-6">
      <div className="w-14 h-14 rounded-2xl bg-amber-100 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 flex items-center justify-center mb-5">
        <ShieldAlert size={26} />
      </div>
      <h1 className="text-lg font-bold text-neutral-900 dark:text-warm-gray-100">Something went wrong</h1>
      <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-2 max-w-sm leading-relaxed">
        The app hit a loading problem. Refresh to recover the latest version.
      </p>
      {error?.message ? (
        <p className="mt-3 max-w-sm rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-2 font-mono text-[11px] text-neutral-500 dark:text-neutral-400 break-words">
          {error.message}
        </p>
      ) : null}
      <button
        onClick={() => window.location.reload()}
        className="inline-flex items-center gap-2 px-4 py-2 mt-6 bg-black dark:bg-[#0ea971] dark:text-white text-white text-xs font-semibold rounded-xl cursor-pointer hover:opacity-90"
      >
        <RefreshCw size={14} /> Refresh app
      </button>
    </div>
  );
}

class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (this.state.error) return <FullScreenError error={this.state.error} />;
    return this.props.children;
  }
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
          className="inline-flex items-center gap-2 px-4 py-2 bg-black dark:bg-[#0ea971] dark:text-white text-white text-xs font-semibold rounded-xl cursor-pointer hover:opacity-90"
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
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: 24 * 60 * 60_000,
        buster: CACHE_VERSION,
        dehydrateOptions: {
          // Only successful results are worth keeping. Persisting an error would show a stale
          // failure on next load for a request that would now succeed.
          shouldDehydrateQuery: (q) => q.state.status === 'success',
        },
      }}
    >
      <HashRouter>
        <AuthProvider>
          <AppErrorBoundary>
            <RootRoutes />
          </AppErrorBoundary>
        </AuthProvider>
      </HashRouter>
    </PersistQueryClientProvider>
  </StrictMode>
);
