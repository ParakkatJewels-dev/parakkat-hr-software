import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// A unique id per build, embedded in the app AND written to dist/version.json. The running app
// polls version.json (see src/lib/versionCheck.js) and reloads when it changes — so a redeploy of
// the hosted web app updates every device with no reinstall.
const BUILD_ID = String(Date.now())

// Writes dist/version.json after the bundle is emitted.
function versionStamp() {
  return {
    name: 'version-stamp',
    apply: 'build',
    closeBundle() {
      writeFileSync(join(process.cwd(), 'dist', 'version.json'), JSON.stringify({ version: BUILD_ID }))
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  define: {
    'import.meta.env.VITE_BUILD_ID': JSON.stringify(BUILD_ID),
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
