// Self-hosted auto-update: the app is served from a hosted URL (Capacitor server.url), and each
// build stamps a unique dist/version.json (see vite.config.js). This hook remembers the version it
// loaded with, then re-checks periodically and whenever the app returns to the foreground. When the
// hosted version.json changes (i.e. you redeployed), it reloads the webview so the device picks up
// the new build — no reinstall, no app-store update. Reloads happen while the app is hidden, or the
// moment the user returns to it, so active work is never interrupted mid-screen.
import { useEffect } from 'react';

async function fetchVersion() {
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.version ?? null;
  } catch {
    return null; // offline or version.json not hosted — ignore, try again later
  }
}

export function useVersionCheck({ intervalMs = 120_000 } = {}) {
  useEffect(() => {
    let baseline = null;   // the version this session started on
    let pending = false;   // a newer version is live but we're waiting for a safe moment
    let stopped = false;

    const reload = () => { if (!stopped) window.location.reload(); };

    const check = async () => {
      const v = await fetchVersion();
      if (v == null || stopped) return;
      if (baseline == null) { baseline = v; return; }
      if (v !== baseline) {
        pending = true;
        // Safe to refresh right away while the app isn't being looked at.
        if (document.visibilityState !== 'visible') reload();
      }
    };

    check();
    const id = setInterval(check, intervalMs);

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (pending) reload();   // returned to the app with an update waiting
      else check();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      stopped = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs]);
}
