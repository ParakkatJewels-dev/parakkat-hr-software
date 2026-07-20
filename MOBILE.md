# Parakkat HR — Mobile App (Capacitor)

The Android and iOS apps are the **same React web app** (`frontend/`) wrapped in a native shell with
[Capacitor](https://capacitorjs.com). No separate mobile codebase — you edit the web app, rebuild,
and sync. RLS scopes each employee to their own data, so it's safe for staff to install.

## Layout (each part is its own top-level folder)

```
HR_Software/
├── frontend/            the React web app  (built to frontend/dist)
├── backend/             Supabase (migrations, scripts, rosters)
├── android/             native Android project (Capacitor)
├── ios/                 native iOS project (Capacitor)
├── capacitor.config.json  appId, appName, webDir -> frontend/dist
└── package.json         root: mobile build scripts + Capacitor toolchain
```

Mobile commands run from the **repo root** (that's where Capacitor lives now).

- **App name:** Parakkat HR   ·   **App ID:** `com.parakkatjewels.hr`

## Prerequisites

| Platform | You need |
|----------|----------|
| **Android** | [Android Studio](https://developer.android.com/studio) (bundles JDK + SDK). Works on **Windows**. |
| **iOS** | A **Mac** with **Xcode**. Apple blocks iOS builds on Windows — use a Mac or a cloud-Mac CI (Ionic Appflow, Codemagic, GitHub Actions macOS runner). |

## Everyday workflow

After any change to the web app:

```bash
# from the repo root
npm run cap:sync        # builds frontend + copies it into android & ios
```

## Run / build Android (Windows OK)

```bash
# from the repo root
npm run android         # builds web, syncs, opens Android Studio
```
In Android Studio: pick a device/emulator and press **Run** ▶, or **Build → Build APK/Bundle** for an
installable **APK** or a signed **AAB** (Play Store).

## Run / build iOS (Mac only)

```bash
# from the repo root, on a Mac
npm run ios             # builds web, syncs, opens Xcode
```
In Xcode: choose a simulator/device and **Run** ▶; **Product → Archive** for the App Store.

## Notes

- **Employees need logins.** A staff member can use the app once their login exists and is linked to
  their employee record: `python backend/scripts/create_user.py someone@parakkat.com`, then in the app
  **Administration → Users & Access** link the login to the employee and grant a role.
- **Same Supabase.** The app bundles `VITE_SUPABASE_URL` + the public anon key (from
  `frontend/.env.local`) and talks to your hosted Supabase over HTTPS. Re-run `npm run cap:sync` after
  changing env values.
- **Routing** uses `HashRouter` (URLs like `/#/leave`) so navigation works in the native webview — do
  not switch it back to `BrowserRouter`.
- Capacitor deps live in the **root** `package.json` (toolchain: cli/android/ios + plugins); the
  `frontend/` keeps only `@capacitor/core` + plugins that its JS bundle imports.

## Future native upgrades (optional plugins)

- GPS / geofenced attendance → `@capacitor/geolocation`
- Selfie attendance / receipt capture → `@capacitor/camera`
- Push notifications for approvals → `@capacitor/push-notifications`
- App icon + splash from one image → `@capacitor/assets`

## Store submission (when ready)

- **Google Play:** one-time $25 account; upload a signed AAB.
- **Apple App Store:** $99/yr account; archive + upload via Xcode.
