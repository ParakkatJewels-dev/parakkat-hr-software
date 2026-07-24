import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// HashRouter (not BrowserRouter): the native webview serves from a local origin where
// history/path routing is fragile — hash routes work identically on web and in Capacitor.
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
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

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
});

function FullScreenLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-50 dark:bg-charcoal-900 text-gold-500">
      <Loader2 size={28} className="animate-spin" />
    </div>
  );
}

// Top-level auth gate: unauthenticated users only ever see /login.
function RootRoutes() {
  const { session, loading } = useAuth();
  if (loading) return <FullScreenLoader />;
  return (
    <Routes>
      <Route path="/login" element={session ? <Navigate to="/" replace /> : <Login />} />
      <Route path="/*" element={session ? <App /> : <Navigate to="/login" replace />} />
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
