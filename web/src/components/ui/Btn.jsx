// The button.
//
// An audit of this app found THIRTY-TWO distinct primary-button class strings — same intent,
// thirty-two slightly different paddings, radii and hovers. No single screen looked wrong; the
// app looked messy because nothing matched. This is the one definition.
//
// Compact by default: this is a data-dense HR tool where a toolbar may carry six controls, so the
// default height is 30px, not the 40px a marketing site would use. `size="lg"` exists for the one
// or two places that genuinely need weight (an empty state's only call to action).
import React from 'react';
import { Loader2 } from 'lucide-react';

const BASE =
  'inline-flex items-center justify-center gap-1.5 font-bold rounded-lg cursor-pointer ' +
  'transition-colors select-none whitespace-normal sm:whitespace-nowrap ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0ea971]/50 ' +
  'disabled:opacity-45 disabled:cursor-not-allowed';

const VARIANT = {
  // One primary per screen area. Black in light mode reads as "the action", green in dark.
  primary: 'bg-neutral-900 text-white hover:bg-neutral-800 dark:bg-[#0ea971] dark:hover:bg-[#0c9765]',
  // The default for anything secondary — bordered, quiet, survives sitting in a row of six.
  ghost:
    'border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-200 ' +
    'hover:border-[#0ea971]/45 hover:text-neutral-900 dark:hover:text-white',
  // No border at all; for actions inside a row or card that should not compete.
  subtle: 'text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-charcoal-800',
  danger: 'bg-red-600 text-white hover:bg-red-700',
  // Destructive but not the main event — reads quiet until you reach for it.
  dangerGhost:
    'border border-neutral-200 dark:border-neutral-800 text-neutral-600 dark:text-neutral-300 ' +
    'hover:border-red-400 hover:text-red-600 dark:hover:text-red-400',
};

const SIZE = {
  sm: 'h-7 px-2 text-xs',
  md: 'h-[30px] px-2.5 text-sm',   // default — the app's working size
  lg: 'h-9 px-4 text-base',
};

/** Square icon-only button. Sizes match SIZE so it lines up in a toolbar. */
const ICON_SIZE = { sm: 'h-7 w-7', md: 'h-[30px] w-[30px]', lg: 'h-9 w-9' };

/**
 * The same styles as a plain class string, for the many existing `className={BTN}` call sites.
 * Lets every screen share one definition without rewriting hundreds of buttons.
 */
export function btnClass(variant = 'ghost', size = 'md', iconOnly = false) {
  return `${BASE} ${VARIANT[variant] ?? VARIANT.ghost} ${iconOnly ? ICON_SIZE[size] : SIZE[size]}`;
}

export default function Btn({
  children,
  variant = 'ghost',
  size = 'md',
  icon: Icon,
  iconOnly = false,
  busy = false,
  className = '',
  type = 'button',
  ...rest
}) {
  // An icon-only button carries no text, so it must be labelled for anyone not looking at it.
  if (iconOnly && !rest['aria-label'] && !rest.title && process.env.NODE_ENV !== 'production') {
    console.warn('Btn: iconOnly needs an aria-label or title.');
  }

  return (
    <button
      type={type}
      disabled={busy || rest.disabled}
      {...rest}
      className={`${BASE} ${VARIANT[variant] ?? VARIANT.ghost} ${
        iconOnly ? ICON_SIZE[size] : SIZE[size]
      } ${className}`}
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : Icon ? <Icon size={13} /> : null}
      {!iconOnly && children}
    </button>
  );
}
