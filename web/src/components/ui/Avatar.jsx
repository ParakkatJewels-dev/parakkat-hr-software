// A person, as a small square.
//
// There were two of these already — one in Team.jsx and one in dashboard/shared.jsx — at different
// sizes, different radii and different colours, which is how the same person looked like two
// different people depending on which screen you were on. This is the one definition.
//
// COLOUR CARRIES IDENTITY, NOT STATUS.
// A thread of eight comments in one grey is eight anonymous paragraphs; the eye needs something to
// group "these three are the same person" without reading the name each time. The tint is derived
// from the name, so it is stable across sessions and devices without storing anything. All shades
// stay within the shared emerald palette. Every pairing is
// dark text on a light tint (and the reverse in dark mode), so contrast does not depend on which
// hue somebody's name happened to land on.
//
// It is decorative: the name is always beside it in the markup, so this is aria-hidden rather than
// labelled, which would otherwise read the same name twice to a screen reader.
import React from 'react';

export const initialsOf = (name) =>
  (name || '?')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();

// Stable shades of the shared brand, with accessible text in both themes.
const TINTS = [
  'bg-brand/5 text-brand-ink',
  'bg-brand/8 text-brand-ink',
  'bg-brand/11 text-brand-ink',
  'bg-brand/14 text-brand-ink',
  'bg-brand/17 text-brand-ink',
  'bg-brand/20 text-brand-ink',
];

/** Stable per name, so the same person is the same colour everywhere and every session. */
export function tintFor(name) {
  const key = String(name || '');
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return TINTS[Math.abs(hash) % TINTS.length];
}

const SIZES = {
  xs: 'w-6 h-6 text-[9px] rounded-md',
  sm: 'w-7 h-7 text-[10px] rounded-lg',
  md: 'w-8 h-8 text-xs rounded-lg',
  lg: 'w-10 h-10 text-sm rounded-xl',
};

export default function Avatar({ name, size = 'md', className = '' }) {
  return (
    <span
      aria-hidden="true"
      title={name || undefined}
      className={`inline-flex items-center justify-center shrink-0 font-bold font-mono select-none ${
        SIZES[size] ?? SIZES.md
      } ${tintFor(name)} ${className}`}
    >
      {initialsOf(name)}
    </span>
  );
}
