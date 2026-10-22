import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOLD_MS, SLOP_PX, edgeSpeed, laneAtX, pressOutcome, startsOnControl, visibleLaneIndexes } from './boardTouch.js';

const start = { x: 100, y: 200 };

test('a press lifts the card only after a still hold; moving first means the person is scrolling', () => {
  assert.equal(HOLD_MS, 250);
  assert.equal(SLOP_PX, 8);
  assert.equal(pressOutcome({ start, point: start, startedAt: 0, now: 100 }), 'wait');
  assert.equal(pressOutcome({ start, point: start, startedAt: 0, now: 249 }), 'wait');
  assert.equal(pressOutcome({ start, point: start, startedAt: 0, now: 250 }), 'lift');
  assert.equal(pressOutcome({ start, point: { x: 105, y: 205 }, startedAt: 0, now: 300 }), 'lift', 'a little wobble (7px) is still a hold');
  assert.equal(pressOutcome({ start, point: { x: 100, y: 209 }, startedAt: 0, now: 120 }), 'scroll', 'moving 9px early is a scroll');
  assert.equal(pressOutcome({ start, point: { x: 109, y: 200 }, startedAt: 0, now: 400 }), 'scroll', 'too far is too far, however long the hold');
  assert.equal(pressOutcome({ start, point: start, startedAt: 0, now: 100, hold: 80 }), 'lift', 'the hold time can be tuned');
});

test('the board scrolls faster the closer the finger gets to an edge, and not at all in the middle', () => {
  const opts = { edge: 50, max: 14 };
  assert.equal(edgeSpeed(200, 0, 400, opts), 0);
  assert.equal(edgeSpeed(50, 0, 400, opts), 0, 'right on the zone line is still still');
  assert.equal(edgeSpeed(350, 0, 400, opts), 0);
  assert.equal(edgeSpeed(25, 0, 400, opts), -7);
  assert.equal(edgeSpeed(0, 0, 400, opts), -14);
  assert.equal(edgeSpeed(-30, 0, 400, opts), -14, 'past the edge is full speed, not faster');
  assert.equal(edgeSpeed(375, 0, 400, opts), 7);
  assert.equal(edgeSpeed(400, 0, 400, opts), 14);
  assert.equal(edgeSpeed(460, 0, 400, opts), 14);
  assert.equal(edgeSpeed(49, 0, 400, opts), -1, 'just inside the zone creeps, never stalls at zero');
  assert.equal(edgeSpeed(20, 0, 60, opts), 0, 'a small box shrinks its zones to a third each');
  assert.equal(edgeSpeed(5, 0, 60, opts), -11);
  assert.equal(edgeSpeed(10, 10, 10, opts), 0, 'an empty box never scrolls');
  assert.equal(edgeSpeed(30, 20, 820), -11, 'defaults: 48px zones at 14px a frame');
});

const lanes = [
  { id: 'todo', left: 29, right: 299 },
  { id: 'progress', left: 309, right: 579 },
  { id: 'review', left: 589, right: 859 },
];

test('the lane under the finger is the one whose span holds it, else the nearest', () => {
  assert.equal(laneAtX(100, lanes), 'todo');
  assert.equal(laneAtX(310, lanes), 'progress');
  assert.equal(laneAtX(303, lanes), 'todo', 'in the gap, the closer side');
  assert.equal(laneAtX(306, lanes), 'progress');
  assert.equal(laneAtX(10, lanes), 'todo', 'past the first lane');
  assert.equal(laneAtX(900, lanes), 'review', 'past the last lane');
  assert.equal(laneAtX(100, []), null);
});

test('the lane dots follow the lanes in view', () => {
  assert.deepEqual(visibleLaneIndexes(lanes, 16, 357), [0], 'resting on the first lane, the next only peeks in');
  assert.deepEqual(visibleLaneIndexes(lanes, 300, 640), [1]);
  assert.deepEqual(visibleLaneIndexes(lanes, 150, 440), [0], 'mid-swipe, the lane showing most');
  assert.deepEqual(visibleLaneIndexes(lanes, 200, 500), [1]);
  assert.deepEqual(visibleLaneIndexes(lanes, 0, 900), [0, 1, 2], 'a wide screen shows them all');
  assert.deepEqual(visibleLaneIndexes([], 0, 400), []);
});

test('pressing a button, field or link inside a card never starts a drag', () => {
  const node = (matches, parent = null) => ({ parent, matches,
    closest(selector) { for (let n = this; n; n = n.parent) if (n.matches(selector)) return n; return null; } });
  const card = node(() => false);
  card.contains = (other) => { for (let n = other; n; n = n.parent) if (n === card) return true; return false; };
  const isButton = (selector) => selector.includes('button');
  const button = node(isButton, card);
  const icon = node(() => false, button);
  const meta = node(() => false, card);
  assert.equal(startsOnControl(button, card), true);
  assert.equal(startsOnControl(icon, card), true, 'an icon inside a button counts as the button');
  assert.equal(startsOnControl(meta, card), false);
  assert.equal(startsOnControl(card, card), false, 'the card itself');
  const outerLink = node((selector) => selector.includes('a,'));
  const inside = node(() => false, node(() => false, outerLink));
  const lonelyCard = node(() => false, outerLink);
  lonelyCard.contains = () => false;
  assert.equal(startsOnControl(inside, lonelyCard), false, 'a control around the board is not the card’s');
  assert.equal(startsOnControl(null, card), false);
});
