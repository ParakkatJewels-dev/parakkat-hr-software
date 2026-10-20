import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let server, AuthContext, AgentAccessSettings, AgentKeyForm, AgentKeyCreated;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  ({ default: AgentAccessSettings, AgentKeyForm, AgentKeyCreated } = await server.ssrLoadModule('/src/components/AgentAccessSettings.jsx'));
});
after(async () => { await server?.close(); });

const key = { id: 'key-9', name: 'Hermes laptop', key_prefix: 'phr_agent123', scopes: ['tasks:manage', 'goals:manage'],
  created_at: '2026-10-20T00:00:00Z', expires_at: '2099-01-01T00:00:00Z', last_used_at: null, revoked_at: null };
const auth = { user: { id: 'viewer', email: 'viewer@example.test' }, isSuperAdmin: true, employee: null, assignments: [], permissions: [] };
function render({ Component = AgentAccessSettings, props = {}, access = { enabled: true, allowed: true }, keys = [key], state } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } } });
  if (state === 'error') client.getQueryCache().build(client, { queryKey: ['my-agent-access', 'viewer'] }).setState({ status: 'error', error: new Error('Unavailable'), fetchStatus: 'idle' });
  else if (state !== 'loading') client.setQueryData(['my-agent-access', 'viewer'], access);
  client.setQueryData(['my-agent-keys', 'viewer'], keys);
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(AuthContext.Provider, { value: auth }, React.createElement(Component, props))));
  } finally { client.clear(); }
}

test('the screen explains in plain words that the assistant acts as you and cannot delete', () => {
  const html = render();
  assert.match(html, /Connect an AI assistant/);
  assert.match(html, /It acts as you/);
  assert.match(html, /only do what your role already allows/);
  assert.match(html, /cannot delete anything/);
  assert.match(html, /Hermes laptop/);
  assert.match(html, /phr_agent123••••••••/);
  assert.match(html, /Tasks &amp; requests/);
  assert.match(html, /aria-label="Revoke key Hermes laptop"/);
  assert.match(html, />\s*<svg[^>]*>.*?<\/svg>\s*Create key<\/button>|Create key/);
});

test('people without the permission, or before the switch is on, see why', () => {
  const blocked = render({ access: { enabled: true, allowed: false } });
  assert.match(blocked, /role does not include connecting an AI assistant/);
  assert.doesNotMatch(blocked, /Create key|Hermes laptop/);
  const off = render({ access: { enabled: false, allowed: true } });
  assert.match(off, /has not turned on AI assistant access yet/);
  assert.match(off, /Create key/);
  assert.match(render({ state: 'loading' }), /Loading AI assistant settings/);
  assert.match(render({ state: 'error' }), /Try again/);
  assert.match(render({ keys: [] }), /no assistant keys yet/);
});

test('five active keys disable creating another; revoked keys have no revoke action', () => {
  const five = Array.from({ length: 5 }, (_, index) => ({ ...key, id: `k${index}`, name: `Key ${index}` }));
  assert.match(render({ keys: five }), /<button type="button" class="[^"]*" disabled="">[^]*?Create key/);
  const revoked = render({ keys: [{ ...key, revoked_at: '2026-10-21T00:00:00Z' }] });
  assert.match(revoked, /data-status="revoked"/);
  assert.doesNotMatch(revoked, /Revoke key/);
});

test('the form offers only assistant areas with tasks ticked and 30 days by default', () => {
  const html = render({ Component: AgentKeyForm, props: { onClose() {}, onCreated() {} } });
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 4);
  assert.equal((html.match(/type="checkbox" checked=""/g) ?? []).length, 1);
  for (const label of ['Tasks &amp; requests', 'Leave approvals', 'Assets', 'Goals']) assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /Employee directory|Attendance|Payroll/);
  assert.match(html, /<option value="30" selected="">30 days/);
  assert.match(html, /maxLength="80"/);
});

test('the one-time view gives a ready Hermes setup with the endpoint and key', () => {
  const html = render({ Component: AgentKeyCreated, props: { name: 'Hermes', value: 'phr_synthetic_only', endpoint: 'https://hr.example.com/api/mcp', onDone() {} } });
  assert.match(html, /only time the key is shown/);
  assert.match(html, /mcp_servers:/);
  assert.match(html, /url: &quot;https:\/\/hr\.example\.com\/api\/mcp&quot;/);
  assert.match(html, /Authorization: &quot;Bearer phr_synthetic_only&quot;/);
  assert.match(html, /\/reload-mcp/);
  assert.match(html, /aria-label="Copy Hermes setup"/);
  assert.match(html, /Done, hide key/);
});
