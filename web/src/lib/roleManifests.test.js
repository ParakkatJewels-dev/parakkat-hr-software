import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { APP_IDENTITIES } from './appName.js';

const publicRoot = new URL('../../public/', import.meta.url);
const manifestFor = (identity) => JSON.parse(readFileSync(
  new URL(identity.manifestHref.slice(1), publicRoot), 'utf8',
));
const expectedNames = {
  default: 'Parakkat',
  admin: 'Parakkat Admin',
  hr: 'Parakkat HR',
  manager: 'Parakkat Manager',
  employee: 'Parakkat Employee',
};

test('every app identity points to a shipped manifest with the same full install name', () => {
  assert.deepEqual(Object.keys(APP_IDENTITIES).sort(), Object.keys(expectedNames).sort());
  for (const [role, identity] of Object.entries(APP_IDENTITIES)) {
    const expectedHref = role === 'default'
      ? '/manifest.webmanifest'
      : `/manifests/${role}.webmanifest`;
    assert.equal(identity.manifestHref, expectedHref, role);
    assert.equal(identity.name, expectedNames[role], role);
    const manifest = manifestFor(identity);
    assert.equal(manifest.name, identity.name, role);
    assert.equal(manifest.short_name, identity.name, role);
    assert.ok(manifest.description.length > 20, role);
  }
});

test('role manifests preserve one app identity and the same root-relative icons', () => {
  const generic = manifestFor(APP_IDENTITIES.default);
  for (const [role, identity] of Object.entries(APP_IDENTITIES)) {
    const manifest = manifestFor(identity);
    assert.equal(manifest.id, '/', role);
    assert.equal(manifest.start_url, '/', role);
    assert.equal(manifest.scope, '/', role);
    assert.equal(manifest.display, 'standalone', role);
    assert.deepEqual(manifest.icons, generic.icons, role);
    assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192'), role);
    assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512'), role);
    assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable'), role);
    const icons = [...manifest.icons, ...manifest.shortcuts.flatMap((shortcut) => shortcut.icons)];
    for (const icon of icons) {
      assert.match(icon.src, /^\/[^/]/, `${role}: ${icon.src} must resolve from the origin root`);
      assert.ok(existsSync(new URL(icon.src.slice(1), publicRoot)), `${role}: ${icon.src}`);
    }
    for (const shortcut of manifest.shortcuts) {
      assert.match(shortcut.url, /^\/#\//, `${role}: ${shortcut.url}`);
    }
  }
});

test('employee and generic shortcuts expose common self-service destinations', () => {
  const common = ['/#/attendance', '/#/dashboard', '/#/leave', '/#/settings', '/#/tasks'];
  for (const role of ['default', 'employee']) {
    const urls = manifestFor(APP_IDENTITIES[role]).shortcuts.map((shortcut) => shortcut.url).sort();
    assert.deepEqual(urls, common, role);
  }
  const managerUrls = manifestFor(APP_IDENTITIES.manager).shortcuts.map((shortcut) => shortcut.url).sort();
  assert.deepEqual(managerUrls, common.filter((url) => url !== '/#/settings'));
});

test('admin and HR manifests retain the people, payroll and reporting shortcuts', () => {
  for (const role of ['admin', 'hr']) {
    const urls = manifestFor(APP_IDENTITIES[role]).shortcuts.map((shortcut) => shortcut.url);
    for (const url of ['/#/directory', '/#/payroll', '/#/reports']) {
      assert.ok(urls.includes(url), `${role}: ${url}`);
    }
  }
});
