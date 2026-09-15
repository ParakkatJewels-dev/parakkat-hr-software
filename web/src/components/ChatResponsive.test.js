import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';
import { chatMenuPosition } from './chatMenuPosition.js';

let server, AuthContext, Thread, Messages;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  ({ Thread, default: Messages } = await server.ssrLoadModule('/src/components/Messages.jsx'));
});
after(async () => { await server?.close(); });

for (const width of [320, 360, 390]) {
  test(`chat action menus stay visible at both edges of a ${width}px screen`, () => {
    const viewport = { width, height: 600 };
    const size = { width: 232, height: 144 };
    for (const anchor of [
      { top: 100, bottom: 144, right: 50 },
      { top: 100, bottom: 144, right: width - 6 },
      { top: 530, bottom: 574, right: width - 6 },
    ]) {
      const position = chatMenuPosition(anchor, size, viewport);
      assert.ok(position.left >= 8);
      assert.ok(position.left + size.width <= width - 8);
      assert.ok(position.top >= 8);
      assert.ok(position.top + size.height <= viewport.height - 8);
      if (anchor.top > 500) assert.ok(position.top + size.height < anchor.top, 'bottom row opens upward');
      else assert.ok(position.top > anchor.bottom, 'top row opens downward');
    }
  });
}

test('long action menus fit a short visual viewport and stay scrollable above the keyboard', () => {
  const viewport = { left: 40, top: 120, width: 280, height: 180 };
  const position = chatMenuPosition({ top: 180, bottom: 224, right: 310 }, { width: 400, height: 600 }, viewport);
  assert.deepEqual(position, { left: 48, top: 128, maxWidth: 264, maxHeight: 164 });
});

const conversation = { id: 'chat-1', kind: 'group', title: 'A long department conversation name',
  members: [{ employee_id: 'employee-1' }], last_message_at: '2026-09-01T12:00:00Z' };

function render(Component, props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, staleTime: Infinity } } });
  client.setQueryData(['conversations'], { conversations: [conversation] });
  const auth = { user: { id: 'user-1' }, employee: { id: 'employee-1' }, isSuperAdmin: false,
    assignments: [], permissions: [], rank: 1 };
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(AuthContext.Provider, { value: auth },
        React.createElement(MemoryRouter, null, React.createElement(Component, props)))));
  } finally { client.clear(); }
}

test('the compact chat header keeps details and search reachable with one overflow trigger', () => {
  for (const readOnly of [false, true]) {
    const html = render(Thread, { conversation, me: 'employee-1', readOnly, onBack() {}, onPreference() {} });
    const header = html.match(/<header class="messages-chat-header"[\s\S]*?<\/header>/)?.[0];
    assert.ok(header);
    for (const label of ['Back to conversations', 'View group details', 'Search messages', 'Conversation menu']) {
      assert.ok(header.includes(`aria-label="${label}"`), label);
    }
    assert.equal((header.match(/aria-haspopup="menu"/g) ?? []).length, 1);
    assert.doesNotMatch(header, /aria-label="Chat settings"/, 'settings remain in the overflow and identity button');
  }
});

test('every conversation has a separate accessible action trigger beside its open-chat button', () => {
  const html = render(Messages);
  assert.match(html, /class="messages-menu-control conversation-row-menu-button"/);
  assert.match(html, /aria-label="Chat menu for A long department conversation name" aria-haspopup="menu" aria-expanded="false"/);
  assert.match(html, /<\/button><div class="messages-menu-control conversation-row-menu-button"/);
});
