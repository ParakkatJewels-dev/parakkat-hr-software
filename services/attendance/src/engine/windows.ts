// Date-window helpers for the engine.
//
// Kept separate from lib/time.ts because these encode an engine rule (how far a punch can sit
// outside its work date and still belong to it) rather than a timezone fact.
import { workDateStart, workDateEnd, eachWorkDate, toWorkDate } from '../lib/time';

/**
 * How far outside its own calendar day a punch may fall and still belong to that work date.
 *
 * Sized for the night-shift case: a 22:00–06:00 shift's exit punch lands 6 hours into the next
 * calendar day, and someone who stays two hours late lands further still. Loading a slightly wider
 * band than needed is cheap; the per-day filter in processDay is what actually assigns punches.
 */
export const RANGE_MARGIN_HOURS = 18;

/**
 * The instants to load punches between when recomputing [from, to].
 * Wider than the range itself so night shifts at either edge are complete.
 */
export function punchWindowBounds(from: string, to: string): { from: Date; to: Date } {
  const marginMs = RANGE_MARGIN_HOURS * 60 * 60_000;
  return {
    from: new Date(workDateStart(from).getTime() - marginMs),
    to: new Date(workDateEnd(to).getTime() + marginMs),
  };
}

export { eachWorkDate, toWorkDate, workDateStart, workDateEnd };
