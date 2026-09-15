import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { createServer } from 'vite';

let server, NotFound;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ default: NotFound } = await server.ssrLoadModule('/src/pages/NotFound.jsx'));
});
after(async () => { await server?.close(); });

const render = (props) => renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: ['/missing'] }, React.createElement(NotFound, props)));

test('the in-app 404 identifies the page and provides an accessible Home link without redirecting', () => {
  const html = render({ appName: 'Parakkat HR' });
  assert.match(html, /<section[^>]*aria-labelledby="not-found-title"/);
  assert.match(html, /<h1[^>]*id="not-found-title"[^>]*>Page not found<\/h1>/);
  assert.match(html, /Parakkat HR/);
  assert.match(html, /aria-label="Error 404"/);
  assert.match(html, /href="\/dashboard"/);
  assert.match(html, /Go to Home/);
  assert.match(html, /min-h-11/);
  assert.doesNotMatch(html, /Access restricted|Something went wrong/);
});

test('signed-out 404 has its own main landmark and full-height light and dark surfaces', () => {
  const html = render({ standalone: true });
  assert.match(html, /<main[^>]*min-h-svh[^>]*dark:bg-charcoal-900/);
  assert.match(html, /Go to Home/);
  assert.doesNotMatch(html, /<section/);
});
