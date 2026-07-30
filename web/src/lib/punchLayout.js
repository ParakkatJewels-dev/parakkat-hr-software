// Where each punch label sits under the timeline bar.
//
// The labels used to be a wrapped list underneath: "09:37 ─ 13:23 ·19m· 13:42 …" in reading order,
// with no relationship to the bar above them. So the bar showed a long afternoon stretch and the
// times sat somewhere below it, and matching one to the other meant counting along.
//
// Putting each label at its own position is the obvious fix and brings the obvious problem:
// punches minutes apart land on top of each other. Kasinath's 29 July has 13:42 and 13:48 six
// minutes apart on a nine-hour bar — 1% of the width. So labels that would collide drop to a second
// row, and a third if they must, each with a leader line back to its point on the bar.
//
// Pure and dependency-free so the packing can be tested — see punchLayout.test.js.

/** Roughly how much width one "13:42" label needs, as a percentage of the bar. */
const DEFAULT_MIN_GAP = 7;

/**
 * Position and row for every punch.
 *
 * Greedy: each label takes the topmost row where it clears the last label already on that row.
 * That keeps the common case — a handful of well-spaced punches — on a single row, and only pushes
 * down the ones that genuinely cannot fit.
 *
 * @returns {{punch: *, pct: number, row: number, align: 'start'|'middle'|'end'}[]}
 */
export function labelLayout(punches, minGapPercent = DEFAULT_MIN_GAP) {
  if (!Array.isArray(punches) || punches.length === 0) return [];

  const first = new Date(punches[0]).getTime();
  const last = new Date(punches[punches.length - 1]).getTime();
  const span = last - first;

  // Rightmost percentage placed on each row so far.
  const rowEnds = [];

  return punches.map((punch) => {
    const pct = span > 0
      ? Math.min(100, Math.max(0, ((new Date(punch).getTime() - first) / span) * 100))
      : 0;

    let row = 0;
    while (rowEnds[row] != null && pct - rowEnds[row] < minGapPercent) row += 1;
    rowEnds[row] = pct;

    // A label centred on 0% or 100% would hang off the container, so the ends anchor instead of
    // centring. Nothing clips and the first and last times stay flush with the bar they describe.
    const align = pct <= minGapPercent / 2 ? 'start' : pct >= 100 - minGapPercent / 2 ? 'end' : 'middle';

    return { punch, pct, row, align };
  });
}

/** How many rows the layout needs, so the container can reserve the height. */
export function rowCount(layout) {
  return layout.reduce((n, l) => Math.max(n, l.row + 1), 0);
}
