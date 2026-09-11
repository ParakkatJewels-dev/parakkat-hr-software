import test from 'node:test';
import assert from 'node:assert/strict';
import { constrainLens, dragIntent, insideDock, nearestDestination, stepSpring } from './liquidGlassMotion.js';

test('a spring settles at a selected destination at both phone and high-refresh frame rates', () => {
  for (const fps of [30, 60, 120]) {
    let position = 5, velocity = 0;
    for (let frame = 0; frame < fps * 2; frame += 1) ({ position, velocity } = stepSpring(position, velocity, 260, 1 / fps));
    assert.ok(Math.abs(position - 260) < 0.01, `${fps}fps position ${position}`);
    assert.ok(Math.abs(velocity) < 0.01, `${fps}fps velocity ${velocity}`);
  }
});

test('an interrupted spring can reverse direction and survives a delayed frame', () => {
  let position = 0, velocity = 0;
  for (let frame = 0; frame < 8; frame += 1) ({ position, velocity } = stepSpring(position, velocity, 300, 1 / 60));
  ({ position, velocity } = stepSpring(position, velocity, 60, 10));
  assert.ok(Number.isFinite(position) && Number.isFinite(velocity));
  for (let frame = 0; frame < 120; frame += 1) ({ position, velocity } = stepSpring(position, velocity, 60, 1 / 60));
  assert.ok(Math.abs(position - 60) < 0.01);
});

test('a fast or overshooting lens never paints beyond either dock edge', () => {
  for (const width of [58.42, 110, 304]) {
    for (const position of [-100, 0, 150, 304, 600]) {
      const lens = constrainLens(position, width, 0.13, 304);
      const expansion = width * lens.stretch / 2;
      assert.ok(lens.x - expansion >= -0.00001);
      assert.ok(lens.x + width + expansion <= 304.00001);
    }
  }
});

test('normal taps and vertical page scrolling do not become navigation scrubs', () => {
  assert.equal(dragIntent(40, 30, 45, 34), 'pending');
  assert.equal(dragIntent(40, 30, 44, 65), 'scroll');
  assert.equal(dragIntent(40, 30, 68, 33), 'scrub');
  assert.equal(dragIntent(40, 30, 12, 34), 'scrub');
});

test('scrubbing only chooses an enabled destination, including edges and empty menus', () => {
  const items = [{ id: 'home', x: 5, width: 50 }, { id: 'denied', x: 57, width: 50, disabled: true }, { id: 'profile', x: 109, width: 50 }];
  assert.equal(nearestDestination(items, -20).id, 'home');
  assert.equal(nearestDestination(items, 90).id, 'profile');
  assert.equal(nearestDestination(items, 900).id, 'profile');
  assert.equal(nearestDestination([], 90), null);
  assert.equal(nearestDestination([{ ...items[0], disabled: true }], 5), null);
});

test('a release outside any dock edge cancels the destination commit', () => {
  const dock = { left: 7, right: 313, top: 770, bottom: 830 };
  assert.equal(insideDock(dock, 100, 800), true);
  for (const [x, y] of [[6, 800], [314, 800], [100, 769], [100, 831]]) assert.equal(insideDock(dock, x, y), false);
});
