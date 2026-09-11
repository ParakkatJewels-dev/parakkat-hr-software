import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let server, Pagination, ToggleSwitch;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ default: Pagination } = await server.ssrLoadModule('/src/components/ui/Pagination.jsx'));
  ({ ToggleSwitch } = await server.ssrLoadModule('/src/components/SettingsPage.jsx'));
});
after(async () => { await server?.close(); });

function find(element, predicate) {
  if (!React.isValidElement(element)) return null;
  if (predicate(element)) return element;
  for (const child of React.Children.toArray(element.props.children)) {
    const result = find(child, predicate);
    if (result) return result;
  }
  return null;
}
const paging = {
  page: 10, totalPages: 21, pageSize: 25, count: 525, from: 226, to: 250,
  noun: 'people', setPage() {}, setPageSize() {},
};

test('compact pagination retains the exact page, record range, total and page-size options', () => {
  const tree = Pagination(paging);
  const disclosure = find(tree, element => element.type === 'details');
  const html = renderToStaticMarkup(disclosure);
  assert.match(html, /Page 10 of 21\. 226–250 of 525 people\. Pagination options/);
  assert.match(html, /<b>226–250<\/b> of 525 people/);
  assert.match(html, /aria-label="Rows per page"/);
  assert.match(html, /<option value="25"[^>]* selected="">25<\/option>/);
  assert.match(html, /<option value="200"[^>]*>200<\/option>/);
});

test('all navigation actions still choose the intended page', () => {
  let current = 10;
  const tree = Pagination({ ...paging, setPage: next => { current = typeof next === 'function' ? next(current) : next; } });
  const click = name => find(tree, element => element.props['aria-label'] === name).props.onClick();
  click('First page'); assert.equal(current, 1);
  click('Next page'); assert.equal(current, 2);
  click('Last page'); assert.equal(current, 21);
  click('Previous page'); assert.equal(current, 20);
  click('Page 10'); assert.equal(current, 10);
});

test('the compact page-size control resets the active page and preserves the selected size', () => {
  const changes = [];
  const tree = Pagination({ ...paging, setPageSize: size => changes.push(['size', size]), setPage: page => changes.push(['page', page]) });
  const disclosure = find(tree, element => element.type === 'details');
  find(disclosure, element => element.type === 'select').props.onChange({ target: { value: '100' } });
  assert.deepEqual(changes, [['size', 100], ['page', 1]]);
});

test('first and last page boundaries and loading state keep navigation disabled', () => {
  for (const [page, names] of [[1, ['First page', 'Previous page']], [21, ['Next page', 'Last page']]]) {
    const tree = Pagination({ ...paging, page });
    for (const name of names) assert.equal(find(tree, element => element.props['aria-label'] === name).props.disabled, true);
  }
  const tree = Pagination({ ...paging, disabled: true });
  for (const name of ['First page', 'Previous page', 'Next page', 'Last page']) {
    assert.equal(find(tree, element => element.props['aria-label'] === name).props.disabled, true);
  }
  assert.equal(find(tree, element => element.type === 'select').props.disabled, true);
});

test('the settings theme switch exposes its actual state and toggles both ways', () => {
  let dark = false;
  const control = () => ToggleSwitch({
    checked: dark,
    label: dark ? 'Switch to light mode' : 'Switch to dark mode',
    onChange: () => { dark = !dark; },
  });
  assert.equal(control().props.role, 'switch');
  assert.equal(control().props['aria-checked'], false);
  assert.match(renderToStaticMarkup(control()), /aria-label="Switch to dark mode"/);
  control().props.onClick();
  assert.equal(control().props['aria-checked'], true);
  assert.match(renderToStaticMarkup(control()), /aria-label="Switch to light mode"/);
  control().props.onClick();
  assert.equal(control().props['aria-checked'], false);
});
