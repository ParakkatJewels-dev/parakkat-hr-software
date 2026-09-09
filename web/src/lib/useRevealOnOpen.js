// Bring a panel into view when it opens.
//
// The pattern all over this app is a button that reveals a form below it — Add someone, Ask another
// department, New task, Add a duty. On a laptop the form usually lands in view. On a phone, where
// the button is often already near the bottom of the screen, it opens entirely below the fold: the
// button appears to do nothing, and people press it again, which closes it. That reads as a broken
// control rather than as a form they have not scrolled to.
//
// So: when the panel appears, scroll it into view and move focus to its first field.
//
// SCROLLING AND FOCUS ARE ONE ACT, NOT TWO.
// Focusing an off-screen input makes the browser jump to it instantly, which fights a smooth
// scroll and lands somewhere neither of them chose. The focus therefore waits for the scroll to
// settle, and is applied with preventScroll so it does not re-jump.
//
// prefers-reduced-motion is honoured: the panel still comes into view — that is the point of the
// hook, not decoration — it simply arrives without the animation.
import { useEffect, useRef } from 'react';

const prefersReducedMotion = () => {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
};

/**
 * @param open       whether the panel is showing
 * @param options.focus  select the first field too (default true)
 * @param options.block  scroll alignment; 'nearest' avoids yanking a panel that is already visible
 * @returns a ref to put on the panel's outermost element
 */
export function useRevealOnOpen(open, { focus = true, block = 'nearest' } = {}) {
  const ref = useRef(null);
  // Only act on the transition into open — a re-render while open must not steal focus back from
  // whatever the user has since clicked into.
  const wasOpen = useRef(false);

  useEffect(() => {
    if (!open) {
      wasOpen.current = false;
      return undefined;
    }
    if (wasOpen.current) return undefined;
    wasOpen.current = true;

    const node = ref.current;
    if (!node) return undefined;

    const reduced = prefersReducedMotion();
    // rAF so the panel has been laid out and has its real height before we scroll to it.
    const raf = requestAnimationFrame(() => {
      try {
        node.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block });
      } catch {
        node.scrollIntoView?.();
      }
    });

    let timer = null;
    if (focus) {
      timer = setTimeout(() => {
        const first = node.querySelector(
          'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])'
        );
        // preventScroll: the scroll above already chose where to land; focusing without this
        // makes the browser jump again, usually past it.
        try { first?.focus({ preventScroll: true }); } catch { first?.focus(); }
      }, reduced ? 0 : 320);
    }

    return () => {
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
    };
  }, [open, focus, block]);

  return ref;
}
