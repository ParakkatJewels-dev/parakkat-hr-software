// A colour utility that names a shade nobody defined compiles to NOTHING — silently.
//
// This app carries a deliberately dense custom `neutral` ramp (105, 205, 305, 405, 455, 505, 605,
// 705, 805, 855 …), and that numbering habit leaked onto Tailwind's stock palettes, which have no
// such steps. `dark:text-emerald-450` was written in nine screens and painted nothing in any of
// them: every one of those badges kept its LIGHT-mode text on a near-black card. There is no build
// error, no lint error and no runtime warning for this — the class simply does not exist.
//
// So: every colour utility in the source must name a shade that either is one of Tailwind's, or is
// declared in index.css. Reads the source directly, because the mistake is IN the source; a test
// that read the compiled CSS would only be able to say the CSS matches itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Tailwind's own scale, shared by every stock palette. */
const TAILWIND_SHADES = new Set(['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950']);

/** Everything index.css declares as `--color-<name>-<shade>`, which Tailwind turns into utilities. */
function declaredShades() {
  const css = readFileSync(join(SRC, 'index.css'), 'utf8');
  const byColour = new Map();
  for (const [, colour, shade] of css.matchAll(/--color-([a-z]+(?:-[a-z]+)*)-(\d{2,3})\s*:/g)) {
    if (!byColour.has(colour)) byColour.set(colour, new Set());
    byColour.get(colour).add(shade);
  }
  return byColour;
}

function sourceFiles(dir = SRC, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.jsx?$/.test(name) && !name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

const UTILITY = new RegExp(
  String.raw`(?<![\w-])(?:(?:dark|hover|focus|active|disabled|group-hover|focus-visible|focus-within|peer-focus):)*` +
  String.raw`(text|bg|border|divide|ring|from|to|via|fill|stroke|decoration|outline|accent|caret|placeholder|shadow)` +
  String.raw`-([a-z]+(?:-[a-z]+)*)-(\d{2,3})(?![\w-])`,
  'g'
);

test('every colour utility in the source names a shade that exists', () => {
  const declared = declaredShades();
  const dead = [];

  for (const file of sourceFiles()) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      // Comments explain these mistakes; they must not be reported as making them.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      for (const [, util, colour, shade] of line.matchAll(UTILITY)) {
        const custom = declared.get(colour);
        // A custom palette is authoritative for itself: `charcoal` has no Tailwind original, so
        // only index.css can say which steps exist. A stock palette accepts either.
        const ok = custom?.has(shade) || (TAILWIND_SHADES.has(shade) && !isCustomOnly(colour, declared));
        if (!ok) dead.push(`${file.replace(SRC + '/', '')}:${i + 1}  ${util}-${colour}-${shade}`);
      }
    });
  }

  assert.deepEqual(
    dead, [],
    `These class names generate no CSS at all — the element silently keeps whatever it inherited:\n  ${dead.join('\n  ')}\n\n` +
    'Either use a real shade, or declare the step in the @theme block of index.css.'
  );
});

/** A palette Tailwind does not ship: only index.css defines its steps. */
function isCustomOnly(colour, declared) {
  return ['charcoal', 'warm-gray', 'gold'].includes(colour) && declared.has(colour);
}

test('the guard can actually see a bad shade', () => {
  // Proves the regex and the shade tables agree — without this, an over-eager `ok` would make the
  // test above pass on an empty search and look like a clean bill of health.
  const declared = declaredShades();
  const bad = [...'dark:text-emerald-450'.matchAll(UTILITY)][0];
  assert.ok(bad, 'the utility pattern no longer matches a real class name');
  const [, , colour, shade] = bad;
  assert.equal(declared.get(colour)?.has(shade) ?? false, false);
  assert.ok(TAILWIND_SHADES.has(shade) === false, '450 must not be treated as a Tailwind shade');
});

test('the custom neutral ramp is accepted, not flagged', () => {
  const declared = declaredShades();
  for (const shade of ['105', '455', '805', '855']) {
    assert.ok(declared.get('neutral')?.has(shade), `neutral-${shade} should be declared in index.css`);
  }
});
