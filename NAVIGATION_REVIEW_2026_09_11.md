# Mobile navigation redesign — 11 September 2026

## Delivered

- Five primary destinations: **Home, Tasks, Chat, Time, Profile**. Each opens its actual screen,
  independently of desktop section grouping. Restricted destinations are replaced only by
  permitted alternatives; a Menu fallback remains available when Profile is restricted.
- Profile has a hamburger opening **Menu & settings**, with the full permitted navigation,
  search, Settings and appearance shortcuts, workspace role switching, and sign out.
  The menu remains accessible while profile data loads or fails, and for unlinked accounts.
- A floating clear-glass dock uses a sliding selection capsule, hover lift, press feedback,
  profile avatar with initials fallback, dark appearance, safe-area spacing and 44px targets.
  Reduced-motion, reduced-transparency, increased-contrast and forced-color fallbacks are included.
- Mobile navigation now covers phone and tablet widths through 1023px. At 1024px the desktop
  sidebar takes over. The Profile menu fills phones and becomes a side panel on tablets.

## Verification

- **702 frontend tests passed**, zero failures. New coverage includes exact destinations,
  permission-filtered alternatives, current-page state, and profile loading/error/unlinked cases.
- Frontend lint and production build passed. Existing lint warnings remain. Vite reports a
  500.22 kB main chunk (146.48 kB gzip), slightly above its default 500 kB warning threshold.
- In Chrome at 320px, all seven standard roles showed the five expected destinations and their
  own permitted full menu, with no menu horizontal overflow. Roles checked: Super Admin,
  Entity Admin, HR Manager, Zonal Manager, Branch Manager, Department Head and Employee.
- Direct tab clicks produced the expected routes and headings. Settings and administration
  routes correctly leave all bottom tabs unselected. A Roles search opens Roles directly.
- Phone/tablet geometry and visual checks used 320px, 390px, 768px and 1023px. The dock stayed
  within the viewport; its selection aligned to the active button within 0.02px in measured cases.
  At 1280px the sidebar appeared, the dock hid, and an open mobile menu closed with content focus.
- The Profile dialog focuses Close on opening, wraps Tab/Shift+Tab, makes the background inert,
  closes on Escape, and restores trigger focus. Both appearance directions changed the theme.
- The final employee sweep at 320px passed all **45 route checks plus the keyboard skip check**,
  including expected access denials and fixture output checks. No writes were attempted.

## Scope and limits

Work was split across dock styling, Profile entry, and navigation testing/review agents, then
integrated and checked using the production React components with 525 synthetic employees.
Run `npm run qa:browser` in `web/` to reproduce the browser fixture checks at port 5174.

This is a CSS recreation of the requested iOS glass appearance and motion. It has not been
verified on physical iOS hardware or Safari; accessibility media-query fallbacks were reviewed
in code rather than emulated in this browser session. Fixture timings are not a concurrent-user
load benchmark. Backend files were unchanged, so service/database suites were not rerun for
this navigation-only change. Nothing was deployed.
