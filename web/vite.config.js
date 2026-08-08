import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// A unique id per build, embedded in the app AND written to dist/version.json. The running app
// polls version.json (see src/lib/versionCheck.js) and reloads when it changes — so a redeploy of
// the hosted web app updates every device with no reinstall.
const BUILD_ID = String(Date.now())

// Writes dist/version.json, and stamps the same build id into the service worker.
function versionStamp() {
  return {
    name: 'version-stamp',
    apply: 'build',
    closeBundle() {
      const dist = join(process.cwd(), 'dist')
      writeFileSync(join(dist, 'version.json'), JSON.stringify({ version: BUILD_ID }))

      // The service worker's cache name has to change when the build does, and it cannot be left
      // to whoever edits sw.js next.
      //
      // A browser decides whether to install a new worker by byte-comparing sw.js. With the
      // version as a hand-typed literal, a deploy that forgets to bump it ships identical bytes,
      // so `install` never re-runs, `cacheShell()` never re-runs, and `activate`'s cleanup — which
      // only deletes caches whose NAME differs — becomes dead code. The shell cached on the day the
      // worker first installed is then served forever. Worse, it is served in preference to the
      // fresher copy in the runtime cache, because CacheStorage.match() returns the first hit in
      // cache-creation order and the shell cache was created first. A user on a flaky connection
      // boots a months-old index.html pointing at asset hashes the CDN no longer serves, and the
      // lazy chunk for whichever screen they open next 404s into a MIME error.
      //
      // The version check compounds it: versionCheck.js adopts whatever it first sees as its
      // baseline, so it reads the NEW build id, finds no mismatch, and certifies the stale session
      // as current. Nothing anywhere tells the user or us.
      //
      // Stamping it here means the cache name always tracks the bundle. If the marker is ever
      // renamed or removed the build fails loudly rather than silently shipping a frozen worker.
      const swPath = join(dist, 'sw.js')
      const sw = readFileSync(swPath, 'utf8')
      const marker = /const VERSION = '[^']*'/
      if (!marker.test(sw)) {
        throw new Error(
          "version-stamp: could not find `const VERSION = '...'` in dist/sw.js. The service " +
            'worker cache name must be stamped with the build id — see the comment in vite.config.js.'
        )
      }
      writeFileSync(swPath, sw.replace(marker, `const VERSION = 'parakkat-hr-${BUILD_ID}'`))
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  define: {
    'import.meta.env.VITE_BUILD_ID': JSON.stringify(BUILD_ID),
  },
  build: {
    // Keep Vite's hashed JS/CSS away from the app's human /assets route. If an old chunk URL under
    // /assets ever missed the filesystem, Vercel's SPA fallback for Asset Management could answer
    // with index.html, which browsers reject as a module MIME mismatch.
    assetsDir: 'app-assets',
  },
  plugins: [
    react(),
    tailwindcss(),
    versionStamp(),
  ],
  server: {
    fs: {
      // Vite's defaults PLUS the nested backend/ — the dev server must never serve the
      // service_role key, the employee-PII spreadsheets, the SQL, or the admin scripts.
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/backend/**'],
    },
  },
})
