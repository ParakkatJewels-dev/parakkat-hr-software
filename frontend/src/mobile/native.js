// Native-shell setup. All of this is a no-op on the web build — it only runs inside the
// Capacitor (Android/iOS) app, so importing it in main.jsx is safe for both targets.
import { Capacitor } from '@capacitor/core';

export async function initNative() {
  if (!Capacitor.isNativePlatform()) return;

  document.body.classList.add('cap-native');

  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    // Don't draw web content under the status bar (clean handling of notches / safe areas).
    await StatusBar.setOverlaysWebView({ overlay: false });
    // Follow the app's saved theme: light text on the dark default, dark text in light mode.
    const isDark = localStorage.getItem('theme') !== 'light';
    await StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light });
    if (Capacitor.getPlatform() === 'android') {
      await StatusBar.setBackgroundColor({ color: isDark ? '#0f0f0f' : '#ffffff' });
    }
  } catch { /* status bar plugin unavailable */ }

  try {
    const { SplashScreen } = await import('@capacitor/splash-screen');
    await SplashScreen.hide();
  } catch { /* no splash plugin */ }

  try {
    const { App } = await import('@capacitor/app');
    // Android hardware back button: navigate back, or exit at the root screen.
    App.addListener('backButton', ({ canGoBack }) => {
      if (canGoBack) window.history.back();
      else App.exitApp();
    });
  } catch { /* app plugin unavailable */ }
}
