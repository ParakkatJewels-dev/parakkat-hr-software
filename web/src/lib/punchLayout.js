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
 * Assign rows so that nothing on the same row overlaps.
 *
 * Greedy, left to right: each item takes the topmost row where it clears whatever is already there.
 * The common case — a handful of well-spaced labels — stays on one row, and only what genuinely
 * cannot fit is pushed down. Shared by the punch times below the bar and the durations above it, so
 * the two cannot develop different ideas of what "overlapping" means.
 *
 * Items must arrive in ascending `pct` order, which both callers naturally produce.
 *
 * @param {{pct: number, needs: number}[]} items  needs = width required, in percent of the bar
 */
export function packRows(items) {
  const rowEnds = [];
  return items.map((item) => {
    const half = item.needs / 2;
    let row = 0;
    // `pct` is the label's centre, so it occupies pct ± half.
    while (rowEnds[row] != null && item.pct - half < rowEnds[row]) row += 1;
    rowEnds[row] = item.pct + half;
    return { ...item, row };
  });
}

/**
 * Position and row for every punch.
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

/** "19m" / "1h 33m" — short enough to sit on a bar segment. */
export function shortDuration(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
}

/**
 * Roughly how much of the bar's width one character of a label takes.
 *
 * The label row is 2xs — about 6px a character — and these bars render around 520 to 620px wide
 * inside the expanded day. 1.15% a character is the conservative end of that, so a label declared
 * to fit does fit rather than being clipped at the narrow end of the range.
 */
const PERCENT_PER_CHAR = 1.15;

/**
 * How long each stretch of the day lasted, positioned over the middle of that stretch.
 *
 * Restored after the punch labels moved under the bar: the old wrapped list carried the break
 * lengths between the times — "09:37 ─ 13:23 ·19m· 13:42" — and positioning the times lost them, so
 * the bar showed a gap with no measurement anywhere near it.
 *
 * A stretch narrower than its own text gets `fits: false` and is left to the tooltip. Six minutes on
 * a nine-hour bar is 1% of the width and there is no honest way to write "6m" across it — a label
 * that overflows its own segment points at the wrong stretch, which is worse than no label.
 */
export function spanLabels(segs, punches) {
  if (!Array.isArray(segs) || segs.length === 0 || !Array.isArray(punches) || punches.length < 2) {
    return [];
  }

  const start = new Date(punches[0]).getTime();
  const total = new Date(punches[punches.length - 1]).getTime() - start;
  if (total <= 0) return [];

  const at = (ts) => ((new Date(ts).getTime() - start) / total) * 100;

  const items = segs.map((s) => {
    const from = at(s.from);
    const to = at(s.to);
    const widthPct = Math.max(0, to - from);
    const text = s.unknown ? '?' : shortDuration(s.minutes);
    const needs = text.length * PERCENT_PER_CHAR + 1;
    return {
      ...s,
      text,
      pct: from + widthPct / 2,
      widthPct,
      needs,
      // Wide enough to sit inside its own stretch. When false the label still shows — it moves to a
      // row of its own above, with a leader line — because the break length is the number people
      // opened the day to read. Nineteen minutes on a nine-hour bar is 3.4% of the width and "19m"
      // needs about 4.5%, so hiding it would have lost the commonest case.
      inline: widthPct >= needs,
    };
  });

  return packRows(items);
}
