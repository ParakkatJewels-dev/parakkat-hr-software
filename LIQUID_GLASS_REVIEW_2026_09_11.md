# Liquid-glass navigation enhancement — 11 September 2026

The web dock now has a separate blurred material surface, directional edge highlights,
a subtle spectral rim, hover/press icon magnification, and a spring-driven selection lens.
The lens stretches with velocity and follows horizontal dragging; release inside selects
the destination, while release outside or cancellation returns to the current page.
The five destinations and Profile → Menu & settings flow are preserved.

## Implementation and review

- Motion runs through a single requestAnimationFrame loop and DOM style properties, with no
  application rerender per frame. The loop stops when settled; no new dependencies were added.
- Lens expansion stays inside the dock. A fresh tap clears stale cancellation suppression.
  Vertical gestures do not become horizontal navigation, and keyboard activation remains native.
- Profile magnification matches the other icons. Menu fallback uses the real button activation
  so focus restoration remains correct, and it does not become a false current-page selection.
- Reduced motion disables spring/deformation; reduced transparency, increased contrast and
  forced colors replace the glass treatment. These preference branches were reviewed in code.
- The QA browser server has its own Vite dependency cache. Concurrent SSR tests previously
  invalidated a lazy dashboard dependency and caused preview reloads; isolating the cache fixed it.

## Validation

- **708 frontend tests passed**, including six new spring/gesture tests. The spring settles at
  30/60/120fps and remains stable across delayed frames and direction reversals.
- Lint and production build passed. Existing lint warnings remain; Vite warns about the main
  chunk at 507.27 kB (149.12 kB gzip), up about 2.64 kB gzip from the preceding navigation build.
- Chrome checks at 320px, 390px, 768px and 1023px showed a centered dock, at least 44px button
  height and no main-content horizontal overflow. Measured settled lens alignment error was
  below 0.01px. At 1280px the dock was hidden and desktop navigation was visible.
- In light and dark appearance, inspected the Profile page and dock visually. Verified normal
  taps, drag from Home to Time, release-outside cancellation, keyboard activation of Tasks,
  Profile menu opening/closing and Settings routing. A canceled scrub on Settings leaves the
  lens hidden and press state reset rather than selecting a false destination.
- For each of Super Admin, Entity Admin, HR Manager, Zonal Manager, Branch Manager, Department
  Head and Employee, clicked all five primary buttons and verified the actual route and current
  tab, then opened the permitted full menu with zero horizontal overflow.
- All browser work used the isolated local adapter with 525 synthetic employees. No employee
  records or messages were written. No backend files changed and nothing was deployed.

## Native fidelity limit

This is a web approximation, not Apple's renderer. Apple's documented Liquid Glass material
and system controls belong to its native UI frameworks; see
[Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass)
and [Applying Liquid Glass to custom views](https://developer.apple.com/documentation/swiftui/applying-liquid-glass-to-custom-views).
The current Capacitor shell hosts React navigation in a web view. Exact native parity would
require a native tab bar and a bridge for route, role, theme and menu state.

No SVG backdrop refraction was enabled: [WebKit issue 245510](https://bugs.webkit.org/show_bug.cgi?id=245510)
documents unresolved support problems. Edge lighting is simulated; underlying content is
blurred, not geometrically refracted. Physical iOS/Safari and native gesture behavior were not
device-tested. The active developer directory is CommandLineTools, so a native Xcode build
was unavailable in this session.
