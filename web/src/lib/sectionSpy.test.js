import test from 'node:test';
import assert from 'node:assert/strict';
import { currentSectionId } from './sectionSpy.js';

// A profile mid-scroll: the marker line sits at 200, Contact and Employment have gone past it,
// Personal is still below.
const SCROLLED = [
  { id: 'contact', top: -420 },
  { id: 'employment', top: -120 },
  { id: 'organization', top: 140 },
  { id: 'personal', top: 460 },
  { id: 'statutory', top: 780 },
];

test('the current section is the last one to have passed the marker, not the first one touching it', () => {
  assert.equal(currentSectionId(SCROLLED, { line: 200 }), 'organization');
});

test('at the top of the page the first section is current, even before it reaches the marker', () => {
  const top = [
    { id: 'contact', top: 320 },
    { id: 'employment', top: 640 },
  ];
  assert.equal(currentSectionId(top, { line: 200 }), 'contact');
});

// The bug this rule exists to fix: the last section can sit entirely below the marker with the page
// already scrolled as far as it goes, so no marker test will ever pick it.
test('the end of the scroll selects the last section however far below the marker it starts', () => {
  const tail = [
    { id: 'emergency', top: -300 },
    { id: 'assets', top: 60 },
    { id: 'documents', top: 520 },
  ];
  assert.equal(currentSectionId(tail, { line: 200 }), 'assets');
  assert.equal(currentSectionId(tail, { line: 200, atBottom: true }), 'documents');
});

test('a section exactly on the marker counts as reached', () => {
  const flush = [{ id: 'a', top: 0 }, { id: 'b', top: 200 }, { id: 'c', top: 400 }];
  assert.equal(currentSectionId(flush, { line: 200 }), 'b');
});

test('nothing to observe reports nothing, so a caller can leave its state alone', () => {
  assert.equal(currentSectionId([], { line: 200 }), null);
  assert.equal(currentSectionId(undefined, { line: 200 }), null);
});

test('one section is always the answer, at any scroll position', () => {
  const only = [{ id: 'contact', top: 900 }];
  assert.equal(currentSectionId(only, { line: 200 }), 'contact');
  assert.equal(currentSectionId(only, { line: 200, atBottom: true }), 'contact');
});
