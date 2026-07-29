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

/**
 * The range a recompute should actually process: ordered, and never reaching past today.
 *
 * Pure and separate from recompute() so it can be tested, because getting it wrong is silent and
 * expensive. Two ways it has already gone wrong here:
 *
 *   1. NOT CLAMPING. `--month 2026-07` run on the 29th wrote two further days of "Absent" for all
 *      162 employees. A future date has no punches, and no punches on a working day is an absence.
 *
 *   2. CLAMPING WITHOUT ORDERING FIRST. Pulling `to` back to today while `from` stays in the
 *      future leaves from > to. That looks harmless because eachWorkDate quietly swaps a backwards
 *      pair — but the loaders do not swap. They query `between '2026-09-01' and '2026-07-29'`,
 *      find nothing, and score a real day as a company-wide absence. On 2026-07-29 that turned 138
 *      punches into 162 people marked absent.
 *
 * So the order is: order the pair, clamp the end, then refuse what is left if it is empty.
 */
export function resolveRecomputeRange(
  from: string,
  to: string,
  today: string
): { from: string; to: string } {
  const lo = from <= to ? from : to;
  const requestedHi = from <= to ? to : from;
  const hi = requestedHi > today ? today : requestedHi;

  if (lo > hi) {
    throw new Error(
      `nothing to recompute: ${from} .. ${to} is entirely in the future (today is ${today})`
    );
  }
  return { from: lo, to: hi };
}
