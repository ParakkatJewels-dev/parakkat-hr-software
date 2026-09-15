/** Keep actions reachable beside either edge and above the keyboard on a small screen. */
export function chatMenuPosition(anchor, size, viewport) {
  const margin = 8;
  const gap = 5;
  const leftEdge = (viewport.left ?? 0) + margin;
  const topEdge = (viewport.top ?? 0) + margin;
  const rightEdge = (viewport.left ?? 0) + viewport.width - margin;
  const bottomEdge = (viewport.top ?? 0) + viewport.height - margin;
  const maxWidth = Math.max(0, viewport.width - margin * 2);
  const maxHeight = Math.max(0, viewport.height - margin * 2);
  const width = Math.min(size.width, maxWidth);
  const height = Math.min(size.height, maxHeight);
  const below = bottomEdge - anchor.bottom - gap;
  const above = anchor.top - gap - topEdge;
  const top = height <= below || below >= above ? anchor.bottom + gap : anchor.top - gap - height;
  return {
    left: Math.max(leftEdge, Math.min(anchor.right - width, rightEdge - width)),
    top: Math.max(topEdge, Math.min(top, bottomEdge - height)),
    maxWidth,
    maxHeight,
  };
}
