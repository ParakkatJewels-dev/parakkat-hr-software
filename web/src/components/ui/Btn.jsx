// The button.
//
// An audit of this app found THIRTY-TWO distinct primary-button class strings — same intent,
// thirty-two slightly different paddings, radii and hovers. No single screen looked wrong; the
// app looked messy because nothing matched. This is the one definition.
//
// Compact by default: this is a data-dense HR tool where a toolbar may carry six controls, so the
// default height is 30px, not the 40px a marketing site would use. `size="lg"` exists for the one
// or two places that genuinely need weight (an empty state's only call to action).
//
// COLOUR MEANS OUTCOME, NOT EMPHASIS
// Every variant below is picked by what pressing it DOES, so the same answer is the same colour on
// every screen: approving leave, accepting a help request and confirming an allocation are one
// green, and rejecting, declining and deleting are one red. Choosing by "how important does this
// look" is what produced a black Accept next to a red Decline on one screen and the reverse on the
// next.
//
// Cancel is the deliberate exception. A Cancel that only closes a form destroys nothing, and
// painting it red makes people hesitate over the harmless half of the choice — the colour that
// should carry the warning is then spent on the safe option, and the actually destructive button
// beside it has nothing left to distinguish it. Dismissal is `ghost`; red is reserved for the
// press that removes, rejects or cannot be undone.
import React from 'react';
import { Loader2 } from 'lucide-react';

const BASE =
  'inline-flex items-center justify-center gap-1.5 font-bold rounded-lg cursor-pointer ' +
  'transition-colors select-none whitespace-normal sm:whitespace-nowrap ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 ' +
  'disabled:opacity-45 disabled:cursor-not-allowed';

const VARIANT = {
  // One branded primary per screen area: submit the form, open the composer, save the draft.
  primary: 'bg-brand-action text-brand-on hover:bg-brand-action-hover',
  // The default for anything secondary — bordered, quiet, survives sitting in a row of six.
  // This is also what Cancel and Close use: dismissal is not an outcome worth a colour.
  ghost:
    'border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-200 ' +
    'hover:border-brand/45 hover:text-neutral-900 dark:hover:text-white',
  // No border at all; for actions inside a row or card that should not compete.
  subtle: 'text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-charcoal-800',

  // POSITIVE — approve, accept, allocate, confirm-and-proceed. The affirmative half of a decision.
  // Measurably darker than the brand green, not decoratively: white on #0ea971 is 3.03:1 and white
  // on #0c8f60 is still only 4.11:1. #0a7d53 is 5.16:1, the first step that clears the 4.5:1 floor.
  // Dark mode keeps the brand green, where the text on it is not white.
  success: 'bg-brand-action text-brand-on hover:bg-brand-action-hover',
  // Approve, but sitting in a row rather than being the one thing on screen.
  successGhost:
    'border border-brand/40 text-brand-ink dark:text-brand-ink ' +
    'hover:bg-brand/10 hover:border-brand',

  // NEGATIVE — reject, decline, delete, revoke, remove. The half that takes something away.
  danger: 'bg-red-600 text-white hover:bg-red-700',
  // Destructive but not the main event — reads quiet until you reach for it.
  dangerGhost:
    'border border-neutral-200 dark:border-neutral-800 text-neutral-600 dark:text-neutral-300 ' +
    'hover:border-red-400 hover:text-red-600 dark:hover:text-red-400',
  // Rejecting IS the decision here, not an afterthought — used opposite `success` so the two
  // halves of one choice carry equal weight and the reader is not steered toward either.
  dangerSolid: 'border border-red-300 dark:border-red-900/50 text-red-700 dark:text-red-300 ' +
    'bg-red-50 dark:bg-red-950/30 hover:bg-red-100 dark:hover:bg-red-950/50',

  // CAUTION — consequential but reversible: withdraw a request, put an asset in for repair.
  warning:
    'border border-amber-300 dark:border-amber-900/50 text-amber-800 dark:text-amber-300 ' +
    'bg-amber-50 dark:bg-amber-950/30 hover:bg-amber-100 dark:hover:bg-amber-950/50',
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
