// Native-shell setup. All of this is a no-op on the web build — it only runs inside the
// Capacitor (Android/iOS) app, so importing it in main.jsx is safe for both targets.
import { Capacitor } from '@capacitor/core';

const SHELL_COLORS = {
  dark: '#080d0b',
  light: '#f2f5f4',
};

function setBrowserThemeColor(theme) {
  const color = theme === 'light' ? SHELL_COLORS.light : SHELL_COLORS.dark;
  document
    .querySelectorAll('meta[name="theme-color"]')
    .forEach((meta) => meta.setAttribute('content', color));
}

export async function syncNativeTheme(theme = localStorage.getItem('theme') || 'dark') {
  const isDark = theme !== 'light';
  setBrowserThemeColor(isDark ? 'dark' : 'light');

  if (!Capacitor.isNativePlatform()) return;

  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    // Follow the app's saved theme: light text on the dark default, dark text in light mode.
    await StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light });
    if (Capacitor.getPlatform() === 'android') {
      await StatusBar.setBackgroundColor({ color: isDark ? SHELL_COLORS.dark : SHELL_COLORS.light });
    }
  } catch { /* status bar plugin unavailable */ }
}

export async function initNative() {
  if (!Capacitor.isNativePlatform()) return;

  document.body.classList.add('cap-native');

  try {
    const { StatusBar } = await import('@capacitor/status-bar');
    // Don't draw web content under the status bar (clean handling of notches / safe areas).
    await StatusBar.setOverlaysWebView({ overlay: false });
  } catch { /* status bar plugin unavailable */ }

  await syncNativeTheme();

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
