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

test('primary and positive actions share the app palette in both themes', () => {
  for (const variant of ['primary', 'success']) {
    const classes = btnClass(variant);
    assert.match(classes, /bg-brand-action text-brand-on hover:bg-brand-action-hover/);
    assert.doesNotMatch(classes, /bg-black|bg-neutral-900|bg-\[#/);
  }
});

test('danger and caution remain distinct from the brand; dismissals stay neutral', () => {
  assert.match(btnClass('danger'), /bg-red-600/);
  assert.match(btnClass('warning'), /bg-amber-50/);
  assert.doesNotMatch(btnClass('ghost'), /bg-brand-action|bg-red-/);
});

test('avatars use stable brand tints rather than a separate colour palette', () => {
  for (const name of ['Anjali', 'Arjun', 'Sushil', 'Sample Person', '', 'Parakkat']) {
    assert.equal(tintFor(name), tintFor(name));
    assert.match(tintFor(name), /bg-brand\/\d+ text-brand-ink/);
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

test('brand text and action labels meet 4.5:1 contrast in light and dark themes', () => {
  for (const selector of [':root', '\\.dark']) {
    const theme = palette(selector);
    for (const background of ['--accent-action', '--accent-action-hover']) {
      assert.ok(contrast(theme['--accent-on'], theme[background]) >= 4.5, `${selector} action text on ${background}`);
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
