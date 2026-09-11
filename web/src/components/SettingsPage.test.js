import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let server, AuthContext, SettingsPage;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  ({ default: SettingsPage } = await server.ssrLoadModule('/src/components/SettingsPage.jsx'));
});
after(async () => { await server?.close(); });

const employee = {
  id: 'self', full_name: 'Sample Employee', employee_code: 'EMP001', phone: '9876543210',
  branch: { name: 'Central Branch' }, designation: { title: 'Associate' },
};
const workspace = { company_name: 'Sample Company', domain: 'example.test', locale: 'en-IN' };

function render({ linked = true, isSuperAdmin = false, profileState, workspaceState, props = {} } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: {
    retry: false, retryOnMount: false, staleTime: Infinity,
  } } });
  const seed = (key, value, state) => {
    if (state === 'loading') return;
    if (state === 'error') {
      client.getQueryCache().build(client, { queryKey: key }).setState({
        status: 'error', error: new Error('Fixture unavailable'), fetchStatus: 'idle',
      });
    } else client.setQueryData(key, value);
  };
  seed(['employee', 'self'], employee, profileState);
  seed(['org-settings', 'workspace'], workspace, workspaceState);
  const auth = {
    user: { id: 'account', email: 'sample@example.test' }, employee: linked ? employee : null,
    isSuperAdmin, permissions: [], assignments: [],
  };
  try {
    const html = renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(AuthContext.Provider, { value: auth }, React.createElement(SettingsPage, {
        theme: 'light', onToggleTheme() {}, online: true, ...props,
      }))));
    return { html, queryKeys: client.getQueryCache().getAll().map(query => query.queryKey) };
  } finally { client.clear(); }
}

const text = html => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
const attribute = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
const has = (tag, name) => new RegExp(`\\s${name}(?:[\\s=>])`).test(tag);
const openings = (html, tag = '[a-z][a-z0-9-]*') => [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'g'))].map(match => match[0]);

function contents(html, opening) {
  const name = opening.match(/^<([a-z][a-z0-9-]*)/)[1];
  const start = html.indexOf(opening) + opening.length;
  const tags = new RegExp(`</?${name}\\b[^>]*>`, 'g');
  tags.lastIndex = start;
  let depth = 1, match;
  while ((match = tags.exec(html))) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (!depth) return html.slice(start, match.index);
  }
  throw new Error(`Unclosed ${name}`);
}

function inputFor(html, label) {
  const labelTag = openings(html, 'label').find(tag => text(contents(html, tag)).startsWith(label));
  assert.ok(labelTag, `Missing label ${label}`);
  const id = attribute(labelTag, 'for');
  assert.ok(id, `${label} must identify its input`);
  const input = openings(html, 'input').find(tag => attribute(tag, 'id') === id);
  assert.ok(input, `${label} must be associated with an input`);
  return input;
}

function panel(html, name) {
  const tab = openings(html, 'button').find(tag => attribute(tag, 'role') === 'tab'
    && text(contents(html, tag)).trim().startsWith(name));
  assert.ok(tab, `Missing ${name} tab`);
  const target = openings(html).find(tag => attribute(tag, 'id') === attribute(tab, 'aria-controls'));
  assert.ok(target, `${name} must control a panel`);
  assert.equal(attribute(target, 'role'), 'tabpanel');
  assert.equal(attribute(target, 'aria-labelledby'), attribute(tab, 'id'));
  return { tab, target, html: contents(html, target) };
}

function saveButtons(html) {
  return openings(html, 'button').filter(tag => text(contents(html, tag)).includes('Save changes'));
}

test('settings groups have labelled panels and General is the only initially visible section', () => {
  const { html } = render();
  for (const name of ['General', 'Account', 'Security', 'Workspace']) {
    const section = panel(html, name);
    assert.equal(attribute(section.tab, 'aria-selected'), String(name === 'General'));
    assert.equal(attribute(section.tab, 'tabindex'), name === 'General' ? '0' : '-1');
    assert.equal(has(section.target, 'hidden'), name !== 'General');
  }
});

test('general settings preserve theme, time format, install/update actions and connection states', () => {
  const normal = panel(render().html, 'General').html;
  const toggle = openings(normal, 'button').find(tag => attribute(tag, 'role') === 'switch');
  assert.equal(attribute(toggle, 'aria-checked'), 'false');
  assert.equal(attribute(toggle, 'aria-label'), 'Switch to dark mode');
  for (const label of ['Time format', '12-hour', '24-hour', 'Browser', 'Reload', 'Online']) {
    assert.ok(text(normal).includes(label), `Missing preference ${label}`);
  }
  const clockChoices = openings(normal, 'button').filter(tag => attribute(tag, 'aria-pressed') !== undefined);
  assert.equal(clockChoices.length, 2);
  assert.equal(text(contents(normal, clockChoices.find(tag => attribute(tag, 'aria-pressed') === 'true'))), '24-hour17:30');
  const available = panel(render({ props: {
    theme: 'dark', installAvailable: true, updateAvailable: true, online: false,
  } }).html, 'General').html;
  const darkToggle = openings(available, 'button').find(tag => attribute(tag, 'role') === 'switch');
  assert.equal(attribute(darkToggle, 'aria-checked'), 'true');
  assert.equal(attribute(darkToggle, 'aria-label'), 'Switch to light mode');
  for (const label of ['Install', 'Update', 'Offline']) assert.ok(text(available).includes(label));
  const installed = panel(render({ props: { installed: true, installAvailable: true } }).html, 'General').html;
  assert.ok(text(installed).includes('Installed'));
  assert.equal(openings(installed, 'button').filter(tag => text(contents(installed, tag)).trim() === 'Install').length, 0);
});

test('account uses the own employee detail, labels inputs and keeps HR identity read-only', () => {
  const result = render();
  const account = panel(result.html, 'Account').html;
  for (const [label, value] of [
    ['Full Name', 'Sample Employee'], ['Employee Code', 'EMP001'], ['Login Email', 'sample@example.test'],
    ['Branch', 'Central Branch'], ['Designation', 'Associate'],
  ]) {
    const input = inputFor(account, label);
    assert.equal(attribute(input, 'value'), value);
    assert.ok(has(input, 'disabled'), `${label} remains HR-controlled`);
  }
  const phone = inputFor(account, 'Phone');
  assert.equal(attribute(phone, 'value'), employee.phone);
  assert.equal(has(phone, 'disabled'), false);
  assert.equal(saveButtons(account).length, 1);
  assert.ok(saveButtons(account).every(button => has(button, 'disabled')), 'Unchanged phone cannot be saved');
  assert.equal(result.queryKeys.some(key => key[0] === 'employees'), false, 'Settings must not fetch the employee directory');
});

test('unlinked users have an explanatory account state without a phone editor', () => {
  const account = panel(render({ linked: false }).html, 'Account').html;
  assert.match(text(account), /No employee record is linked/);
  assert.equal(openings(account, 'input').some(input => attribute(input, 'type') === 'tel'), false);
  assert.equal(saveButtons(account).length, 0);
});

test('workspace configuration is read-only to employees and editable only to super admins', () => {
  for (const isSuperAdmin of [false, true]) {
    const section = panel(render({ isSuperAdmin }).html, 'Workspace').html;
    for (const label of ['Company Name', 'Company Domain', 'Default Locale']) {
      assert.equal(has(inputFor(section, label), 'disabled'), !isSuperAdmin, label);
    }
    const buttons = saveButtons(section);
    assert.equal(buttons.length, Number(isSuperAdmin));
    if (isSuperAdmin) assert.ok(has(buttons[0], 'disabled'), 'Unchanged workspace cannot be saved');
  }
});

test('account data loading or failure cannot overwrite a saved phone', () => {
  for (const profileState of ['loading', 'error']) {
    const account = panel(render({ profileState }).html, 'Account').html;
    assert.ok(has(inputFor(account, 'Phone'), 'disabled'));
    assert.equal(saveButtons(account).length, 1);
    assert.ok(saveButtons(account).every(button => has(button, 'disabled')));
    if (profileState === 'error') assert.ok(openings(account).some(tag => attribute(tag, 'role') === 'alert'));
  }
});

test('workspace data loading or failure keeps administrator writes disabled', () => {
  for (const workspaceState of ['loading', 'error']) {
    const section = panel(render({ isSuperAdmin: true, workspaceState }).html, 'Workspace').html;
    for (const label of ['Company Name', 'Company Domain', 'Default Locale']) assert.ok(has(inputFor(section, label), 'disabled'));
    assert.ok(saveButtons(section).every(button => has(button, 'disabled')));
    if (workspaceState === 'error') assert.ok(openings(section).some(tag => attribute(tag, 'role') === 'alert'));
  }
});

test('security retains labelled password fields and shared password requirements', () => {
  const security = panel(render().html, 'Security').html;
  for (const label of ['New password', 'Confirm password']) {
    const input = inputFor(security, label);
    assert.equal(attribute(input, 'type'), 'password');
    assert.equal(attribute(input, 'autoComplete'), 'new-password');
    assert.ok(has(input, 'required'));
  }
  for (const label of ['At least 8 characters', 'Not your own name', 'Not only numbers', 'Update password']) {
    assert.ok(text(security).includes(label));
  }
});
