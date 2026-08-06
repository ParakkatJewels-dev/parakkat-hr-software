// A CSS media query, readable from JavaScript and kept in sync.
//
// Tailwind handles the cases where the answer is "style it differently". This is for the ones where
// the answer is "behave differently" — the notification bell opens a dropdown on a pointer and a
// full screen on a phone, and that is a branch in the component, not a class name.
//
// Directory.jsx reads matchMedia directly to pick its initial layout, which is fine because it only
// needs the answer once. Anything that must react to a rotation or a resized window needs the
// subscription, which is what this adds.
import { useSyncExternalStore } from 'react';

/**
 * @param {string} query e.g. '(min-width: 1024px)'
 * Server/SSR and very old browsers get `false` — the mobile-shaped branch, which is the safer
 * default: a full-screen list works with a mouse, while a hover-anchored dropdown does not work
 * with a thumb.
 */
export function useMediaQuery(query) {
  const subscribe = (listener) => {
    const mql = window.matchMedia?.(query);
    if (!mql) return () => {};
    // addEventListener is not available on Safari before 14, which is inside the range of phones
    // still in use here.
    if (mql.addEventListener) {
      mql.addEventListener('change', listener);
      return () => mql.removeEventListener('change', listener);
    }
    mql.addListener(listener);
    return () => mql.removeListener(listener);
  };

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia?.(query).matches ?? false,
    () => false
  );
}

export default useMediaQuery;
