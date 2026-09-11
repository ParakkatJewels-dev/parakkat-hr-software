export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function constrainLens(position, width, stretch, dockWidth) {
  const allowedStretch = Math.min(stretch, width > 0 ? Math.max(0, dockWidth / width - 1) : 0);
  const expansion = width * allowedStretch / 2;
  return { x: clamp(position, expansion, dockWidth - width - expansion), stretch: allowedStretch };
}

// An exact damped-spring step remains stable when a browser skips animation frames.
export function stepSpring(position, velocity, target, elapsed) {
  const dt = clamp(elapsed, 0, 0.064);
  const stiffness = 440;
  const damping = 30;
  const alpha = damping / 2;
  const omega = Math.sqrt(stiffness - alpha * alpha);
  const distance = position - target;
  const decay = Math.exp(-alpha * dt);
  const cosine = Math.cos(omega * dt);
  const sine = Math.sin(omega * dt);
  return {
    position: target + decay * (distance * cosine + (velocity + alpha * distance) / omega * sine),
    velocity: decay * (velocity * cosine - (alpha * velocity + stiffness * distance) / omega * sine),
  };
}

export function nearestDestination(destinations, x) {
  return destinations.reduce((nearest, destination) => {
    if (destination.disabled) return nearest;
    const distance = Math.abs(destination.x + destination.width / 2 - x);
    return !nearest || distance < Math.abs(nearest.x + nearest.width / 2 - x) ? destination : nearest;
  }, null);
}

export function dragIntent(startX, startY, x, y) {
  const dx = Math.abs(x - startX);
  const dy = Math.abs(y - startY);
  if (dy > 10 && dy > dx * 1.2) return 'scroll';
  if (dx > 7 && dx > dy * 1.2) return 'scrub';
  return 'pending';
}

export function insideDock(rect, x, y) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}
