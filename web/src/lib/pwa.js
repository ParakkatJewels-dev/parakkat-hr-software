export function isStandalonePwa() {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;

  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });

  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js');

      const notifyUpdate = () => {
        window.dispatchEvent(new CustomEvent('pwa:update-ready', { detail: { registration } }));
      };

      const safeUpdate = () => {
        registration.update().catch(() => {
          // A blocked/offline update check should never affect the running app.
        });
      };

      if (registration.waiting && navigator.serviceWorker.controller) {
        notifyUpdate();
      }

      registration.addEventListener('updatefound', () => {
        const nextWorker = registration.installing;
        if (!nextWorker) return;

        nextWorker.addEventListener('statechange', () => {
          if (nextWorker.state === 'installed' && navigator.serviceWorker.controller) {
            notifyUpdate();
          }
        });
      });

      safeUpdate();

      window.addEventListener('online', safeUpdate);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') safeUpdate();
      });

      // Long-lived installed PWAs can stay open for days. Check occasionally so the update banner
      // appears even if the user never closes the app.
      setInterval(safeUpdate, 60 * 60_000);
    } catch {
      // The app should still run in browsers or policies that block service workers.
    }
  });
}
