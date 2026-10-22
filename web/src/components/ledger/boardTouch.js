// Finger dragging for the Work Ledger board. Computers keep HTML5 drag-and-drop (Board.jsx); on a
// phone or tablet you press and hold a card, a floating copy follows your finger, the lane under it
// lights up, and the board scrolls when the finger nears an edge. Letting go over another lane moves
// the task the same way a desktop drop does. The small pure rules come first (boardTouch.test.js),
// then the DOM wiring, which Board.jsx attaches to its board element.

/** How long a press must be held before the card lifts, and how far it may wander first. */
export const HOLD_MS = 250;
export const SLOP_PX = 8;
/** Pressing one of these inside a card does its own job and never starts a drag. */
export const NO_DRAG = 'button, input, select, textarea, a, label, [contenteditable]:not([contenteditable="false"])';

const LANE = '.ledger-lane[data-lane-id]';
const CARD = '.ledger-card[data-task-id]';

/**
 * What a held press means so far: 'scroll' once it has moved more than the slop (the person is
 * scrolling, so let it go), 'lift' once it has been held long enough, otherwise 'wait'.
 */
export function pressOutcome({ start, point, startedAt, now, hold = HOLD_MS, slop = SLOP_PX }) {
  if (Math.hypot(point.x - start.x, point.y - start.y) > slop) return 'scroll';
  return now - startedAt >= hold ? 'lift' : 'wait';
}

/**
 * Auto-scroll speed (px per 60 Hz frame) for a finger at `pos` between `start` and `end`: negative
 * near the start edge, positive near the end edge, faster the deeper it goes (and at full speed past
 * the edge), zero in the middle.
 */
export function edgeSpeed(pos, start, end, { edge = 48, max = 14 } = {}) {
  const zone = Math.min(edge, (end - start) / 3);
  if (!(zone > 0)) return 0;
  const intoStart = start + zone - pos;
  const intoEnd = pos - (end - zone);
  const into = intoStart > 0 ? intoStart : intoEnd > 0 ? intoEnd : 0;
  if (!into) return 0;
  const speed = Math.max(1, Math.round(max * Math.min(1, into / zone)));
  return intoStart > 0 ? -speed : speed;
}

/** The lane a finger at `x` is over: the one whose span holds it, otherwise the nearest. */
export function laneAtX(x, spans) {
  let best = null;
  let bestGap = Infinity;
  for (const span of spans) {
    const gap = x < span.left ? span.left - x : x > span.right ? x - span.right : 0;
    if (gap < bestGap) { best = span.id; bestGap = gap; }
  }
  return best;
}

/**
 * Which lanes are in view between `left` and `right`: every lane showing at least `share` of its
 * width, or — mid-swipe, when none is — the one showing the most.
 */
export function visibleLaneIndexes(spans, left, right, share = 0.6) {
  const shown = spans.map((span) => {
    const width = span.right - span.left;
    return width > 0 ? Math.max(0, Math.min(span.right, right) - Math.max(span.left, left)) / width : 0;
  });
  const full = shown.flatMap((value, index) => (value >= share ? [index] : []));
  if (full.length || !shown.length) return full;
  return [shown.indexOf(Math.max(...shown))];
}

/** True when a press starts on a control inside the card (its buttons, fields or links). */
export function startsOnControl(target, card) {
  const control = target?.closest?.(NO_DRAG);
  return Boolean(control && control !== card && card?.contains?.(control));
}

// ---- DOM wiring ---------------------------------------------------------------------------

const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const spansOf = (lanes, clipLeft = -Infinity, clipRight = Infinity) => lanes.map((lane) => {
  const rect = lane.getBoundingClientRect();
  return { id: lane.dataset.laneId, left: Math.max(rect.left, clipLeft), right: Math.min(rect.right, clipRight) };
});

/** The board scroll position that lines `lane` up with the board's snap edge. */
export function laneScrollLeft(board, lane) {
  const pad = parseFloat(getComputedStyle(board).scrollPaddingLeft) || 0;
  return board.scrollLeft + lane.getBoundingClientRect().left - board.getBoundingClientRect().left - pad;
}

/** Indexes of the lanes now in view on the board. */
export function lanesInView(board) {
  if (!board) return [];
  const rect = board.getBoundingClientRect();
  return visibleLaneIndexes(spansOf([...board.querySelectorAll(LANE)]), rect.left, rect.right);
}

/** Scroll the board to `laneId` (phones: one lane per screen). */
export function showLane(board, laneId) {
  const lane = board && [...board.querySelectorAll(LANE)].find((item) => item.dataset.laneId === laneId);
  if (lane) board.scrollTo({ left: laneScrollLeft(board, lane), behavior: reduceMotion() ? 'auto' : 'smooth' });
}

function verticalScroller(element) {
  for (let node = element?.parentElement; node && node !== document.body; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement || document.documentElement;
}

function viewOf(scroller) {
  if (scroller === document.scrollingElement || scroller === document.documentElement) return { top: 0, bottom: window.innerHeight };
  const rect = scroller.getBoundingClientRect();
  return { top: Math.max(rect.top, 0), bottom: Math.min(rect.bottom, window.innerHeight) };
}

/**
 * Wire touch/pen dragging onto a board element. Callbacks: taskFor(id) → task, onLift(task),
 * onOver(laneId | null), onDrop(task, laneId), onEnd(). Returns { destroy }.
 */
export function attachBoardTouchDrag(board, { taskFor, onLift, onOver, onDrop, onEnd }) {
  if (!board) return { destroy() {} };
  let drag = null;

  const laneAt = (x, y) => {
    const hit = document.elementFromPoint(x, y)?.closest?.(LANE);
    if (hit && board.contains(hit)) return hit.dataset.laneId;
    // Between lanes (or just past the board's side edge while scrolling it): the nearest lane.
    const rect = board.getBoundingClientRect();
    if (y < rect.top || y > rect.bottom || x < rect.left - 24 || x > rect.right + 24) return null;
    const spans = spansOf([...board.querySelectorAll(LANE)], rect.left, rect.right).filter((span) => span.right > span.left);
    return laneAtX(x, spans);
  };

  // Scroll by fractional amounts (frame-rate independent) without losing the fractions to rounding.
  const step = (key, element, prop, amount) => {
    if (!element || !amount) return;
    const total = (drag[key] || 0) + amount;
    const whole = Math.trunc(total);
    drag[key] = total - whole;
    if (whole) element[prop] += whole;
  };

  const autoScroll = (factor) => {
    const { x, y } = drag.point;
    const rect = board.getBoundingClientRect();
    const left = Math.max(rect.left, 0);
    const right = Math.min(rect.right, window.innerWidth);
    step('carryX', board, 'scrollLeft', edgeSpeed(x, left, right, { edge: Math.min(56, (right - left) * 0.15) }) * factor);
    // Up and down: the lane under the finger first (phones give each lane its own scroll), then the page.
    const view = viewOf(drag.scroller);
    const lane = drag.over && board.querySelector(`${LANE}[data-lane-id="${drag.over}"]`);
    if (lane && lane.scrollHeight > lane.clientHeight + 1) {
      const box = lane.getBoundingClientRect();
      const speed = edgeSpeed(y, Math.max(box.top, view.top), Math.min(box.bottom, view.bottom), { edge: 40, max: 10 });
      const room = speed < 0 ? lane.scrollTop > 0 : lane.scrollTop + lane.clientHeight < lane.scrollHeight - 1;
      if (speed && room) { step('carryLane', lane, 'scrollTop', speed * factor); return; }
    }
    step('carryY', drag.scroller, 'scrollTop', edgeSpeed(y, view.top, view.bottom, { edge: 56, max: 12 }) * factor);
  };

  const tick = (now) => {
    if (!drag || drag.phase !== 'active') return;
    const factor = drag.lastTick ? Math.min(3, (now - drag.lastTick) / 16.7) : 1;
    drag.lastTick = now;
    drag.ghost.style.translate = `${Math.round(drag.point.x - drag.offset.x)}px ${Math.round(drag.point.y - drag.offset.y)}px`;
    if (drag.armed) autoScroll(factor);
    const over = laneAt(drag.point.x, drag.point.y);
    if (over !== drag.over) { drag.over = over; onOver(over); }
    drag.raf = requestAnimationFrame(tick);
  };

  const lift = () => {
    if (!drag || drag.phase !== 'pending' || !drag.card.isConnected) return;
    const rect = drag.card.getBoundingClientRect();
    drag.phase = 'active';
    drag.offset = { x: drag.start.x - rect.left, y: drag.start.y - rect.top };
    const layer = document.createElement('div');
    layer.className = 'ledger-overlays ledger-drag-layer';
    layer.setAttribute('aria-hidden', 'true');
    const ghost = drag.card.cloneNode(true);
    for (const name of ['tabindex', 'draggable', 'data-dragging', 'aria-label']) ghost.removeAttribute(name);
    ghost.classList.add('ledger-drag-ghost');
    ghost.style.width = `${rect.width}px`;
    ghost.style.transformOrigin = `${drag.offset.x}px ${drag.offset.y}px`;
    ghost.style.translate = `${Math.round(rect.left)}px ${Math.round(rect.top)}px`;
    layer.append(ghost);
    document.body.append(layer);
    drag.layer = layer;
    drag.ghost = ghost;
    drag.scroller = verticalScroller(board);
    board.dataset.dragging = '';
    try { navigator.vibrate?.(10); } catch { /* no buzz, no matter */ }
    onLift(drag.task);
    drag.raf = requestAnimationFrame(tick);
  };

  const settle = (laneId) => {
    // Phones snap one lane per screen; snapping is off mid-drag so the board can glide, so line the
    // board back up — on the lane the card went to, or the one most in view.
    if (!/mandatory/.test(getComputedStyle(board).scrollSnapType)) return;
    if (laneId) { showLane(board, laneId); return; }
    const lanes = [...board.querySelectorAll(LANE)];
    const [index] = lanesInView(board);
    if (lanes[index]) showLane(board, lanes[index].dataset.laneId);
  };

  const end = (commit, laneId = null) => {
    const current = drag;
    if (!current) return;
    drag = null;
    clearTimeout(current.timer);
    cancelAnimationFrame(current.raf);
    listen(false);
    if (current.phase !== 'active') return;
    current.layer.remove();
    delete board.dataset.dragging;
    onEnd();
    if (commit && laneId && laneId !== current.task.lane) onDrop(current.task, laneId);
    settle(commit ? laneId : null);
  };

  const onPointerMove = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.point = { x: event.clientX, y: event.clientY };
    if (drag.phase === 'pending') {
      const outcome = pressOutcome({ start: drag.start, point: drag.point, startedAt: drag.startedAt, now: performance.now() });
      if (outcome === 'scroll') end(false);
      else if (outcome === 'lift') lift();
      return;
    }
    // Picking a card up near the edge should not set the board sliding until the finger moves.
    if (!drag.armed && Math.hypot(drag.point.x - drag.start.x, drag.point.y - drag.start.y) > SLOP_PX * 1.5) drag.armed = true;
  };
  const onPointerUp = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (drag.phase === 'active') end(true, laneAt(event.clientX, event.clientY));
    else end(false);
  };
  const onCancel = () => end(false);
  const onKey = (event) => { if (event.key === 'Escape') end(false); };
  const onContextMenu = (event) => { if (drag) event.preventDefault(); };
  const onHidden = () => { if (document.visibilityState === 'hidden') end(false); };

  function listen(on) {
    const method = on ? 'addEventListener' : 'removeEventListener';
    window[method]('pointermove', onPointerMove);
    window[method]('pointerup', onPointerUp);
    window[method]('pointercancel', onCancel);
    window[method]('keydown', onKey);
    window[method]('contextmenu', onContextMenu);
    window[method]('blur', onCancel);
    document[method]('visibilitychange', onHidden);
  }

  const onPointerDown = (event) => {
    if (drag || event.pointerType === 'mouse' || !event.isPrimary || event.button > 0) return;
    const card = event.target?.closest?.(CARD);
    if (!card || !board.contains(card) || card.getAttribute('draggable') !== 'true' || startsOnControl(event.target, card)) return;
    const task = taskFor(card.dataset.taskId);
    if (!task?.can_edit) return;
    const point = { x: event.clientX, y: event.clientY };
    drag = { phase: 'pending', pointerId: event.pointerId, task, card, start: point, point, startedAt: performance.now() };
    drag.timer = setTimeout(lift, HOLD_MS);
    listen(true);
  };
  // While a card is up the finger must not scroll the page. This listener is in place before any
  // touch starts (iOS only honours preventDefault from listeners that were), and is a no-op otherwise.
  const blockScroll = (event) => { if (drag?.phase === 'active' && event.cancelable) event.preventDefault(); };
  // A touch press is ours: keep the browser's own long-press drag (Android, iOS) out of it.
  const blockNativeDrag = (event) => { if (drag) { event.preventDefault(); event.stopPropagation(); } };

  board.addEventListener('pointerdown', onPointerDown);
  board.addEventListener('touchmove', blockScroll, { passive: false });
  board.addEventListener('dragstart', blockNativeDrag, true);
  return {
    destroy() {
      end(false);
      board.removeEventListener('pointerdown', onPointerDown);
      board.removeEventListener('touchmove', blockScroll, { passive: false });
      board.removeEventListener('dragstart', blockNativeDrag, true);
    },
  };
}
