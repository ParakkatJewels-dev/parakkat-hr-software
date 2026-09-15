import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../../public/sw.js', import.meta.url), 'utf8');
class BrowserResponse extends Response {
  get type() { return 'basic'; }
  clone() {
    const copy = super.clone();
    return new BrowserResponse(copy.body, { status: copy.status, statusText: copy.statusText, headers: copy.headers });
  }
}
const html = (body, status = 200) => new BrowserResponse(body, { status, headers: { 'Content-Type': 'text/html' } });

function worker() {
  const listeners = new Map(), stores = new Map(), reads = [];
  const key = request => new URL(typeof request === 'string' ? request : request.url, 'https://example.test').href;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async match(request) { return store.get(key(request))?.clone(); },
        async put(request, response) { store.set(key(request), response.clone()); },
        async keys() { return [...store.keys()].map(url => ({ url })); },
        async delete(request) { return store.delete(key(request)); },
      };
    },
    async match(request) {
      for (const store of stores.values()) if (store.has(key(request))) return store.get(key(request)).clone();
    },
  };
  const state = { respond: () => new BrowserResponse('asset'), reads, caches, stores };
  vm.runInNewContext(source, { self: { location: { origin: 'https://example.test' },
    addEventListener: (name, handler) => listeners.set(name, handler) },
    URL, Request, Response: BrowserResponse, caches,
    fetch: async (request, options) => { reads.push({ url: key(request), options }); return state.respond(request, options); },
  });
  state.request = async (path, { mode = 'cors', method = 'GET', preload } = {}) => {
    const background = [];
    let pending;
    listeners.get('fetch')({ request: { url: new URL(path, 'https://example.test').href, method, mode },
      preloadResponse: Promise.resolve(preload), respondWith: response => { pending = response; },
      waitUntil: task => background.push(task),
    });
    const result = await pending;
    await Promise.all(background);
    return result;
  };
  return state;
}

test('a hashed build asset is fetched once and a new hash fetches the new build', async () => {
  const sw = worker();
  assert.equal(await (await sw.request('/app-assets/App-Abcd1234.js')).text(), 'asset');
  await sw.request('/app-assets/App-Abcd1234.js');
  assert.equal(sw.reads.length, 1);
  await sw.request('/app-assets/App-Efgh5678.js');
  assert.equal(sw.reads.length, 2);
});

test('missing build assets are repaired once and error responses never enter the cache', async () => {
  const sw = worker();
  sw.respond = () => html('Missing', 404);
  assert.equal((await sw.request('/app-assets/App-Abcd1234.js')).status, 404);
  assert.equal(sw.reads.length, 2);
  assert.equal(sw.reads[1].options.cache, 'reload');
  sw.respond = () => new BrowserResponse('repaired');
  assert.equal(await (await sw.request('/app-assets/App-Abcd1234.js')).text(), 'repaired');
  assert.equal(sw.reads.length, 3);
});

test('HTTP and preload 404s stay 404s instead of becoming the cached home screen', async () => {
  const sw = worker();
  sw.respond = () => html('home');
  await sw.request('/', { mode: 'navigate' });
  sw.respond = () => html('Custom page not found', 404);
  const missing = await sw.request('/does-not-exist', { mode: 'navigate' });
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), 'Custom page not found');
  const reads = sw.reads.length;
  assert.equal((await sw.request('/another-missing', { mode: 'navigate', preload: html('Missing', 404) })).status, 404);
  assert.equal(sw.reads.length, reads, 'navigation preload avoids a second request');
  assert.equal(await (await sw.caches.match('/index.html')).text(), 'home');
});

test('standalone pages cannot overwrite the application shell and outages still have a fallback', async () => {
  const sw = worker();
  sw.respond = () => html('home');
  await sw.request('/', { mode: 'navigate' });
  sw.respond = () => html('Standalone 404 document');
  await sw.request('/404.html', { mode: 'navigate' });
  assert.equal(await (await sw.caches.match('/index.html')).text(), 'home');
  sw.respond = () => html('Unavailable', 503);
  assert.equal(await (await sw.request('/', { mode: 'navigate' })).text(), 'home');
  sw.respond = () => { throw new TypeError('Network unavailable'); };
  assert.equal(await (await sw.request('/', { mode: 'navigate' })).text(), 'home');
});

test('API and deploy checks always bypass caches; cross-origin requests and writes remain untouched', async () => {
  const sw = worker();
  for (const path of ['/api/v1/employees', '/version.json', '/sw.js']) {
    await sw.request(path); await sw.request(path);
  }
  assert.equal(sw.reads.length, 6);
  assert.ok(sw.reads.every(read => read.options.cache === 'no-store'));
  assert.equal(await sw.request('https://private.supabase.co/rest/v1/employees'), undefined);
  assert.equal(await sw.request('/api/v1/employees', { method: 'POST' }), undefined);
  assert.equal(sw.reads.length, 6);
  assert.equal(sw.stores.size, 0);
});

test('unknown same-origin data is never cached and never replaced by an offline HTML response', async () => {
  const sw = worker();
  await sw.request('/private-report'); await sw.request('/private-report');
  assert.equal(sw.reads.length, 2);
  assert.equal(sw.stores.size, 0);
  sw.respond = () => { throw new TypeError('Offline'); };
  await assert.rejects(sw.request('/private-report'), /Offline/);
});
