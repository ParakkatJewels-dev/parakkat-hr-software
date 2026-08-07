// Which section of a long scrolling page the reader is actually looking at.
//
// The employee profile is one scroll of nine sections with a rail beside it, and the rail is only
// worth having if its highlight agrees with the screen. This is the rule that decides which one is
// current, kept away from React and the DOM so it can be tested directly — the component's only
// job is to measure the tops and hand them over.
//
// It replaces an IntersectionObserver over a narrow band near the top of the viewport, which got
// two things wrong. An observer callback carries only the entries that CHANGED, so "the topmost
// intersecting section" was being decided from a partial set and the highlight followed whichever
// section entered the band last rather than the one on screen. And the final section can never
// reach a band that high up, because the page runs out of scroll first — so the last entry in the
// rail could not be highlighted at all, however hard it was clicked.

/**
 * The current section id.
 *
 * @param tops     `[{ id, top }]` in document order, each top measured in the same coordinate
 *                 space as `line` (viewport coordinates are what the DOM hands back).
 * @param line     The marker: a section counts as current once its top has passed this.
 * @param atBottom The scroll is at its end. The last section wins outright — the tail of a page
 *                 can sit entirely below the marker and still be the only thing on screen.
 *
 * Returns null for an empty list, so a caller with nothing to observe can leave its state alone.
 */
export function currentSectionId(tops, { line = 0, atBottom = false } = {}) {
  if (!Array.isArray(tops) || tops.length === 0) return null;
  if (atBottom) return tops[tops.length - 1].id;

  // The last one that has passed the marker. Nothing has, at the very top of a page whose first
  // section starts below the line — that is still the first section, not "no section".
  let current = tops[0].id;
  for (const section of tops) {
    if (section.top <= line) current = section.id;
  }
  return current;
}

export default currentSectionId;
