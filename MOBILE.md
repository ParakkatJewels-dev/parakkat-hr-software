# Parakkat HR — Mobile App (Capacitor)

The Android and iOS apps are the **same React web app** (`web/`) wrapped in a native shell with
[Capacitor](https://capacitorjs.com). No separate mobile codebase — you edit the web app, rebuild,
and sync. RLS scopes each employee to their own data, so it's safe for staff to install.

## Layout

```
HR_Software/
├── web/                 the React web app  (built to web/dist)
│   └── backend/         Supabase (migrations, scripts, rosters) — never in the build
├── android/             native Android project (Capacitor)
├── ios/                 native iOS project (Capacitor)
├── capacitor.config.json  appId, appName, webDir -> web/dist
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
npm run cap:sync        # builds the web app + copies it into android & ios
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
  their employee record: `python web/backend/scripts/create_user.py someone@parakkat.com`, then in the app
  **Administration → Users & Access** link the login to the employee and grant a role.
- **Same Supabase.** The app bundles `VITE_SUPABASE_URL` + the public anon key (from
  `web/.env.local`) and talks to your hosted Supabase over HTTPS. Re-run `npm run cap:sync` after
  changing env values.
- **Routing** uses `HashRouter` (URLs like `/#/leave`) so navigation works in the native webview — do
  not switch it back to `BrowserRouter`.
- Capacitor deps live in the **root** `package.json` (toolchain: cli/android/ios + plugins); the
  `web/` keeps only `@capacitor/core` + plugins that its JS bundle imports.

## Auto-update (hosted web app + version check)

The app is a native shell that **loads the web app from a URL you host**, so redeploying the web app
updates every phone — no reinstall, no app-store update. A version check reloads the webview when a
new build is live.

How it's wired:
- `capacitor.config.json` → `server.url` points the native app at your hosted web app.
- Each build stamps a unique `dist/version.json` (see `web/vite.config.js`).
- `web/src/lib/versionCheck.js` (mounted in `App`) remembers the loaded version, re-checks every
  couple of minutes and on every foreground, and reloads when `version.json` changes — while the app
  is hidden, or the moment the user returns, so it never interrupts mid-screen.

**One-time setup (Vercel)**

1. **Import the repo on [vercel.com](https://vercel.com)** → New Project. In the settings:
   - **Root Directory:** `web`  ← important (the app lives in `web/`, not the repo root).
   - Framework preset **Vite**, build `npm run build`, output `dist` (already set in `web/vercel.json`).
   - **Environment Variables:** add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
     (copy the values from `web/.env.local`). Vite inlines these at build time, so the deployed app
     can't reach Supabase without them.
   Deploy → you get a URL like `https://parakkat-hr.vercel.app`.
2. Put that URL in `capacitor.config.json` → `server.url` (replace `REPLACE-WITH-YOUR-HOSTED-WEB-URL`).
3. Build the APK **once** and hand it to staff:
   ```bash
   npm run android             # build the APK in Android Studio, distribute it
   ```

**Ship a feature update (after that, every time)**

Just `git push` — Vercel auto-builds and deploys `web/`. Phones reload to the new version on their
own (within ~2 min, or the moment a user reopens the app). No APK, no reinstall.

> `web/vercel.json` marks `version.json` and `index.html` as no-cache (so updates are seen instantly)
> and the hashed `assets/*` as immutable (fast loads).

> Notes:
> - The app now needs internet to open (it loads from the URL) — it already needed it for Supabase.
> - Native-code changes (adding a Capacitor plugin, editing `capacitor.config.json`, app icon/splash)
>   still need a fresh APK — this flow ships the web layer only.
> - Keep the host on **HTTPS** (required by `androidScheme: https`).

## Future native upgrades (optional plugins)

- GPS / geofenced attendance → `@capacitor/geolocation`
- Selfie attendance / receipt capture → `@capacitor/camera`
- Push notifications for approvals → `@capacitor/push-notifications`
- App icon + splash from one image → `@capacitor/assets`

## Store submission (when ready)

- **Google Play:** one-time $25 account; upload a signed AAB.
- **Apple App Store:** $99/yr account; archive + upload via Xcode.
