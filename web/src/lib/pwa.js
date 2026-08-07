export function isStandalonePwa() {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

/**
 * iOS, including iPadOS 13 and later — which reports itself as a Mac and can only be told apart by
 * the fact that Macs do not have touchscreens.
 */
export function isIosDevice(ua = navigator.userAgent, maxTouchPoints = navigator.maxTouchPoints) {
  if (/iPad|iPhone|iPod/i.test(ua)) return true;
  return /Macintosh/i.test(ua) && Number(maxTouchPoints) > 1;
}

/**
 * What, if anything, to offer this visitor.
 *
 * NOTHING CAN INSTALL ITSELF. Chromium fires `beforeinstallprompt`, which we keep and can replay —
 * but only from a real user gesture, so the most we can do is put the button in front of somebody
 * instead of making them find it in a browser menu. iOS has no install API at all: Add to Home
 * Screen lives in the share sheet and only a human can reach it. So there are two offers, and both
 * of them are still one tap by the user.
 *
 *   'none'        already installed, or there is nothing useful to say
 *   'prompt'      we hold a deferred prompt and can open the native dialog on tap
 *   'ios-manual'  iOS: show where Add to Home Screen lives, because that is all anyone can do
 */
export function installOffer({ standalone, deferredPrompt, ios }) {
  if (standalone) return 'none';
  if (deferredPrompt) return 'prompt';
  if (ios) return 'ios-manual';
  return 'none';
}

const DISMISS_KEY = 'pwa-install-hidden-until';

/** Suppressed for a fortnight after a dismissal — long enough not to nag, short enough to return. */
export const INSTALL_SNOOZE_DAYS = 14;

export function installPromptHidden(storage, now = Date.now()) {
  try {
    const until = Number(storage?.getItem(DISMISS_KEY));
    return Number.isFinite(until) && until > now;
  } catch {
    return false; // Private mode or a blocked store: showing it is better than crashing.
  }
}

export function hideInstallPrompt(storage, now = Date.now(), days = INSTALL_SNOOZE_DAYS) {
  try {
    storage?.setItem(DISMISS_KEY, String(now + days * 86400000));
  } catch {
    /* nothing to do if the store refuses; the prompt simply reappears next visit */
  }
}

const PRELOAD_RELOAD_KEY = 'pwa-preload-error-reloaded-at';
export const PRELOAD_RELOAD_WINDOW_MS = 15_000;

export function shouldReloadAfterPreloadError(storage = window.sessionStorage, now = Date.now()) {
  try {
    const storedAt = storage?.getItem(PRELOAD_RELOAD_KEY);
    const last = storedAt == null ? NaN : Number(storedAt);
    if (Number.isFinite(last) && now - last < PRELOAD_RELOAD_WINDOW_MS) return false;
    storage?.setItem(PRELOAD_RELOAD_KEY, String(now));
    return true;
  } catch {
    return true;
  }
}

export function installPreloadErrorHandler({ storage = window.sessionStorage, reload = () => window.location.reload() } = {}) {
  window.addEventListener('vite:preloadError', (event) => {
    if (!shouldReloadAfterPreloadError(storage)) return;
    event.preventDefault();
    reload();
  });
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
