import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let server, SearchSelect, optionsFrom, matches, SEARCH_FROM;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ default: SearchSelect, optionsFrom, matches, SEARCH_FROM } = await server.ssrLoadModule('/src/components/ui/SearchSelect.jsx'));
});
after(async () => { await server?.close(); });

const h = React.createElement;

test('a dropdown reads its options straight from the <option> children it replaces', () => {
  const options = optionsFrom([
    h('option', { key: 'a', value: '' }, 'Everyone'),
    [h('option', { key: 'b', value: 'p1' }, 'Asha ', 'Menon'), false, null],
    h('optgroup', { key: 'g', label: 'Former staff' }, h('option', { value: 'p2', disabled: true }, 'Ravi')),
  ]);
  assert.deepEqual(options, [
    { value: '', label: 'Everyone', disabled: false, group: undefined },
    { value: 'p1', label: 'Asha Menon', disabled: false, group: undefined },
    { value: 'p2', label: 'Ravi', disabled: true, group: 'Former staff' },
  ]);
});

test('search ignores case and accents', () => {
  assert.equal(matches('Ananya Nair', 'nair'), true);
  assert.equal(matches('José Kurian', 'jose'), true);
  assert.equal(matches('Branch 12', 'branch 3'), false);
  assert.equal(matches('Anything', '  '), true);
});

test('it shows the chosen option on a button and keeps a hidden native select in step for forms', () => {
  const html = renderToStaticMarkup(h(SearchSelect, { value: 'p1', onChange() {}, 'aria-label': 'Filter tasks by person', required: true, className: 'field' },
    h('option', { value: '' }, 'Everyone'), h('option', { value: 'p1' }, 'Asha Menon')));
  assert.match(html, /<button[^>]*class="search-select field"[^>]*aria-haspopup="listbox"[^>]*aria-expanded="false"[^>]*aria-label="Filter tasks by person"/);
  assert.match(html, /<span class="search-select-value">Asha Menon<\/span>/);
  assert.match(html, /<select class="search-select-native" tabindex="-1" aria-hidden="true"[^>]*required=""/);
  assert.ok(SEARCH_FROM >= 5, 'short lists stay a plain list');
});
