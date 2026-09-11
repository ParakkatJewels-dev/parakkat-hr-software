// Explicit, local-only QA entry. Production Vite never imports this configuration or its fixtures.
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root, configFile: false, envDir: false,
  // SSR component tests start their own Vite servers. Keep their dependency cache separate
  // so a concurrent test run cannot invalidate chunks used by the open browser preview.
  cacheDir: resolve(root, 'node_modules/.vite-qa'),
  define: { 'import.meta.env.VITE_BUILD_ID': JSON.stringify('isolated-qa') },
  plugins: [{
    name: 'isolated-qa', enforce: 'pre',
    resolveId(id) {
      if (/\/supabaseClient(?:\.js)?$/.test(id)) return resolve(root, 'qa/client.js');
    },
    transformIndexHtml(html) {
      return html.replace(/src="\/src\/main\.jsx[^\"]*"/, 'src="/qa/entry.jsx"')
        .replace('<head>', '<head><meta http-equiv="Content-Security-Policy" content="connect-src \'self\' ws://127.0.0.1:5174; form-action \'self\';">');
    },
  }, react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 5174, strictPort: true, hmr: false,
    fs: { deny: ['.env', '.env.*', '**/backend/**', '**/.git/**'] } },
});
await server.listen();
console.log('Isolated HR QA: http://127.0.0.1:5174 (525 synthetic employees; no external data connections)');
