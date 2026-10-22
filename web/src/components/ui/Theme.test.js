import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createServer } from 'vite';

let server, btnClass, tintFor;
before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  ({ btnClass } = await server.ssrLoadModule('/src/components/ui/Btn.jsx'));
  ({ tintFor } = await server.ssrLoadModule('/src/components/ui/Avatar.jsx'));
});
after(async () => { await server?.close(); });

test('primary actions are the coral action colour and approvals are green, in both themes', () => {
  assert.match(btnClass('primary'), /bg-brand-action text-brand-on hover:bg-brand-action-hover/);
  assert.match(btnClass('success'), /bg-emerald-700 text-white hover:bg-emerald-800/);
  for (const variant of ['primary', 'success']) assert.doesNotMatch(btnClass(variant), /bg-black|bg-neutral-900|bg-\[#/);
});

test('danger and caution remain distinct from the brand; dismissals stay neutral', () => {
  assert.match(btnClass('danger'), /bg-red-600/);
  assert.match(btnClass('warning'), /bg-amber-50/);
  assert.doesNotMatch(btnClass('ghost'), /bg-brand-action|bg-red-/);
});

test('avatars use stable pastel tints with same-hue text in both themes', () => {
  for (const name of ['Anjali', 'Arjun', 'Sushil', 'Sample Person', '', 'Parakkat']) {
    assert.equal(tintFor(name), tintFor(name));
    assert.match(tintFor(name), /^bg-(\w+)-100 text-\1-[78]00 dark:bg-\1-950\/60 dark:text-\1-200$/);
  }
});

const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');
const palette = (selector) => {
  const block = css.match(new RegExp(`^${selector} \\{([\\s\\S]*?)^\\}`, 'm'))?.[1];
  assert.ok(block, `Missing ${selector} palette`);
  return Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*(#[\da-fA-F]{6})\b/g)].map(match => [match[1], match[2]]));
};
const luminance = (hex) => hex.slice(1).match(/../g)
  .map(value => parseInt(value, 16) / 255)
  .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
  .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);

test('brand text meets 4.5:1 and action labels stay on the chosen coral in light and dark themes', () => {
  for (const selector of [':root', '\\.dark']) {
    const theme = palette(selector);
    // The action colour is the redesign's exact coral (#ff5a27) with white text, about 3:1. A deeper,
    // 4.5:1 shade was offered and the owner chose the exact board colour on 22 Oct 2026, so this
    // pins that choice (and stops it drifting lighter) instead of the 4.5:1 floor.
    assert.equal(theme['--accent-action'], '#ff5a27', `${selector} action colour`);
    for (const background of ['--accent-action', '--accent-action-hover']) {
      assert.ok(contrast(theme['--accent-on'], theme[background]) >= 2.9, `${selector} action text on ${background}`);
    }
    for (const background of ['--surface-elevated', '--surface-subtle', '--surface-muted']) {
      assert.ok(contrast(theme['--accent-ink'], theme[background]) >= 4.5, `${selector} brand text on ${background}`);
    }
  }
});

test('app components use semantic utilities instead of hard-coded brand colours', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const jsxFiles = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? jsxFiles(path) : entry.name.endsWith('.jsx') ? [path] : [];
  });
  const hardcoded = /(?:bg|text|border|ring)-\[#(?:0ea971|10b981|0a7d53|086b47|0c9765|0a7d54|095f41|0a8c5d|0c7d55)\]/i;
  for (const file of jsxFiles(root)) assert.doesNotMatch(readFileSync(file, 'utf8'), hardcoded, file);
});
