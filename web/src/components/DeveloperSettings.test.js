import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let server, AuthContext, DeveloperSettings, CreateKeyForm, CreatedKey, KeyRow;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  ({ default: DeveloperSettings, CreateKeyForm, CreatedKey, KeyRow } = await server.ssrLoadModule('/src/components/DeveloperSettings.jsx'));
});
after(async () => { await server?.close(); });

const metadata = { id: 'key-1', name: 'Reporting dashboard', key_prefix: 'hr_live_test', scopes: ['employees:read'],
  entity_id: 'company-1', created_at: '2026-01-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z', last_used_at: null, revoked_at: null };
const auth = { user: { id: 'viewer', email: 'viewer@example.test' }, isSuperAdmin: true, employee: null, assignments: [], permissions: [] };
function render({ Component = DeveloperSettings, props = {}, isSuperAdmin = true, enabled = false, keys = [metadata], state } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } } });
  const seed = (queryKey, data) => {
    if (state === 'loading') return;
    if (state === 'error') client.getQueryCache().build(client, { queryKey }).setState({ status: 'error', error: new Error('Unavailable'), fetchStatus: 'idle' });
    else client.setQueryData(queryKey, data);
  };
  seed(['developer-settings', 'viewer'], { enabled, updated_at: null });
  seed(['developer-api-keys', 'viewer'], keys);
  client.setQueryData(['org', 'all'], { entities: [{ id: 'company-1', name: 'Sample Company' }], branches: [], departments: [], designations: [], zones: [] });
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(AuthContext.Provider, { value: { ...auth, isSuperAdmin } }, React.createElement(Component, props))));
  } finally { client.clear(); }
}

test('developer settings requires super admin even if mounted outside the route guard', () => {
  const html = render({ isSuperAdmin: false });
  assert.match(html, /Access restricted/);
  assert.doesNotMatch(html, /Create key|Reporting dashboard|role="switch"/);
});

test('API access starts disabled and keys remain visible without enabling access', () => {
  const html = render();
  assert.match(html, /role="switch" aria-checked="false" aria-label="Enable API access"/);
  assert.match(html, /Reporting dashboard/);
  assert.match(html, /hr_live_test••••••••/);
  assert.match(html, /Sample Company/);
  assert.match(html, /Last used/);
  assert.match(html, /Never/);
  assert.match(render({ enabled: true }), /role="switch" aria-checked="true"/);
});

test('loading and failed reads do not masquerade as an empty key list or usable switch', () => {
  const loading = render({ state: 'loading' });
  assert.match(loading, /aria-label="Loading API keys"/);
  assert.doesNotMatch(loading, /No API keys yet/);
  const error = render({ state: 'error' });
  assert.match(error, /API settings could not be loaded/);
  assert.match(error, /API keys could not be loaded/);
  assert.match(error, /role="switch"[^>]*disabled=""/);
  assert.doesNotMatch(error, /No API keys yet/);
});

test('create form defaults to directory only, bounded expiry, and explicit company choice', () => {
  const html = render({ Component: CreateKeyForm, props: { entities: [{ id: 'company-1', name: 'Sample Company' }], onClose() {}, onCreated() {} } });
  assert.match(html, /Creating a key does not enable API access/);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 3);
  assert.equal((html.match(/type="checkbox" checked=""/g) ?? []).length, 1);
  assert.match(html, /All companies/);
  assert.match(html, /<option value="90" selected="">90 days/);
  for (const days of [30, 365]) assert.match(html, new RegExp(`<option value="${days}">${days} days`));
  assert.match(html, /maxLength="80"/);
});

test('the one-time key view explains loss on dismiss and labels manual copy fallback input', () => {
  const html = render({ Component: CreatedKey, props: { name: metadata.name, value: 'synthetic-key-only', onDone() {} } });
  assert.match(html, /you will not be able to see it again/);
  assert.match(html, /Your new API key/);
  assert.match(html, /readOnly=""[^>]*value="synthetic-key-only"/);
  assert.match(html, /Copy key/);
  assert.match(html, /Done, hide key/);
});

test('revoked keys have no revoke action and invalid or elapsed expiry is not active', () => {
  const renderRow = item => render({ Component: KeyRow, props: { item, onRevoke() {} } });
  const revoked = renderRow({ ...metadata, revoked_at: '2026-01-02T00:00:00Z' });
  assert.match(revoked, /Revoked/); assert.doesNotMatch(revoked, /Revoke key/);
  for (const expires_at of ['2000-01-01T00:00:00Z', null, 'invalid']) {
    assert.match(renderRow({ ...metadata, expires_at }), /data-status="expired"/);
  }
});

test('getting started names supported endpoints, header, pagination and rate limits', () => {
  const html = render({ keys: [] });
  assert.match(html, /No API keys yet/);
  for (const detail of ['/api/v1', 'Authorization: Bearer YOUR_API_KEY', 'GET /employees', 'GET /organization',
    'GET /attendance', 'from=YYYY-MM-DD', 'to=YYYY-MM-DD', '50 records', 'maximum is 100', '60 requests per minute']) assert.ok(html.includes(detail), detail);
});
