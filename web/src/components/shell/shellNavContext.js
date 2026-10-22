// What the frame knows about where you are, for the page header to print: the section, its screens
// and their counts. App provides it; PageHeader reads it to draw the breadcrumb and the section
// tabs under the title (2026 redesign — the tabs used to sit in a strip under the top bar).
import { createContext, useContext } from 'react';

export const ShellNavContext = createContext(null);

/** null outside the app frame (tests, sign-in), so callers must cope without it. */
export function useShellNav() {
  return useContext(ShellNavContext);
}
