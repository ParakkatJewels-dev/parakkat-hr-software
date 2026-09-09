import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldShowPager, pageSizeOptions, pageWindow } from './pagination.js';

test('the pager appears exactly when there is a second page', () => {
  assert.equal(shouldShowPager(10, 25), false, 'ten rows on a page of 25 is one page');
  assert.equal(shouldShowPager(25, 25), false, 'a full single page still needs no control');
  assert.equal(shouldShowPager(26, 25), true);
});

test('a smaller page size shows the pager sooner — the bug this replaced', () => {
  // The old test compared against the smallest OFFERED size (25), so a fifteen-row list paged at
  // ten drew ten rows and no control, and the last five were unreachable.
  assert.equal(shouldShowPager(15, 10), true, 'fifteen rows at ten a page is two pages');
  assert.equal(shouldShowPager(9, 8), true);
  assert.equal(shouldShowPager(8, 8), false);
});

test('nonsense inputs draw no pager rather than throwing', () => {
  assert.equal(shouldShowPager(0, 25), false);
  assert.equal(shouldShowPager(10, 0), false);
  assert.equal(shouldShowPager(NaN, 25), false);
  assert.equal(shouldShowPager(10, undefined), false);
});

test('the size in use is always offered, so the control cannot misreport itself', () => {
  assert.deepEqual(pageSizeOptions(8), [8, 25, 50, 100, 200]);
  assert.deepEqual(pageSizeOptions(10, [25, 50]), [10, 25, 50]);
});

test('a size already offered is not duplicated, and the list stays ordered', () => {
  assert.deepEqual(pageSizeOptions(25), [25, 50, 100, 200]);
  assert.deepEqual(pageSizeOptions(50, [200, 25, 50]), [25, 50, 200]);
});

test('every window ends at the last page, so the end is always one click away', () => {
  for (const total of [1, 2, 7, 8, 20, 137]) {
    for (const page of [1, Math.ceil(total / 2), total]) {
      const w = pageWindow(page, total);
      assert.equal(w[w.length - 1], total, `total=${total} page=${page}`);
      assert.equal(w[0], 1, `total=${total} page=${page}`);
    }
  }
});

test('seven pages or fewer are all shown, with no ellipsis', () => {
  assert.deepEqual(pageWindow(3, 7), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(pageWindow(1, 1), [1]);
});

test('a long list keeps the current page in view between ellipses', () => {
  assert.deepEqual(pageWindow(10, 20), [1, '…', 9, 10, 11, '…', 20]);
  assert.deepEqual(pageWindow(1, 20), [1, 2, '…', 20]);
  assert.deepEqual(pageWindow(20, 20), [1, '…', 19, 20]);
});

test('a current page outside the range is clamped rather than drawn', () => {
  assert.deepEqual(pageWindow(999, 20), pageWindow(20, 20));
  assert.deepEqual(pageWindow(0, 20), pageWindow(1, 20));
});

test('no pages at all is an empty window, not a crash', () => {
  assert.deepEqual(pageWindow(1, 0), []);
  assert.deepEqual(pageWindow(1, NaN), []);
});
