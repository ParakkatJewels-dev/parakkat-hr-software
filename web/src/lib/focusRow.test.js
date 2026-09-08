import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  focusIdFrom, stripFocus, notificationTarget, pageContaining, focusIsMissing,
} from './focusRow.js';

// ------------------------------------------------------------------ reading ----

test('a focus id is read out of the query string', () => {
  assert.equal(focusIdFrom('?focus=abc-123'), 'abc-123');
});

test('no focus, an empty focus or no query at all is simply nothing to do', () => {
  for (const s of ['', '?', '?other=1', '?focus=', '?focus=%20', undefined, null]) {
    assert.equal(focusIdFrom(s), null, JSON.stringify(s));
  }
});

test('a uuid survives the round trip through the URL', () => {
  const id = '3f1a9c2e-7b4d-4a10-9d2f-8e6c5b1a0d33';
  assert.equal(focusIdFrom(`?${'focus'}=${encodeURIComponent(id)}`), id);
});

test('the focus is read alongside other parameters, not instead of them', () => {
  assert.equal(focusIdFrom('?tab=open&focus=abc&page=2'), 'abc');
});

// ----------------------------------------------------------------- clearing ----

test('the focus is stripped once it has been used', () => {
  assert.equal(stripFocus('?focus=abc'), '');
});

test('stripping the focus leaves every other parameter alone', () => {
  const rest = stripFocus('?tab=open&focus=abc&page=2');
  assert.equal(focusIdFrom(rest), null);
  assert.ok(rest.includes('tab=open') && rest.includes('page=2'), rest);
});

test('stripping a search with no focus changes nothing meaningful', () => {
  assert.equal(focusIdFrom(stripFocus('?tab=open')), null);
  assert.equal(stripFocus(''), '');
});

// ------------------------------------------------------------- where to go ----

const notif = (o) => ({ tab: 'leave', ref_id: 'lv1', ...o });

test('a single notification targets its own row', () => {
  assert.equal(notificationTarget(notif({})), 'leave?focus=lv1');
});

test('a grouped row targets the screen only — there is no honest "which one"', () => {
  // "New leave request x3" stands for three requests. Picking one of them to jump to would be
  // arbitrary and would look like the app losing the other two.
  assert.equal(notificationTarget(notif({ ids: ['a', 'b', 'c'] })), 'leave');
});

test('a group that happens to hold ONE notification still focuses it', () => {
  assert.equal(notificationTarget(notif({ ids: ['lv1'] })), 'leave?focus=lv1');
});

test('a notification with no ref row just opens the screen', () => {
  assert.equal(notificationTarget(notif({ ref_id: null })), 'leave');
});

test('a notification with no tab goes nowhere, rather than to "/undefined"', () => {
  assert.equal(notificationTarget(notif({ tab: null })), null);
  assert.equal(notificationTarget(null), null);
});

test('an inner tab in the target is preserved', () => {
  // Regularizations live at /attendance/regularizations — see urlTab.js.
  assert.equal(
    notificationTarget({ tab: 'attendance/regularizations', ref_id: 'rg1' }),
    'attendance/regularizations?focus=rg1'
  );
});

test('a ref id is encoded, so nothing in it can break the URL', () => {
  const target = notificationTarget({ tab: 'leave', ref_id: 'a b&c=d' });
  assert.equal(focusIdFrom(`?${target.split('?')[1]}`), 'a b&c=d');
});

// ------------------------------------------------------------- paginating ----

const rows = (n) => [...Array(n)].map((_, i) => ({ id: `r${i}` }));

test('a row on the first page needs no jump', () => {
  assert.equal(pageContaining(rows(100), 'r0', 25), 1);
});

test('a row buried on a later page reports that page', () => {
  // r60 of 100 at 25 a page: page 3 holds rows 50..74. Without this the app "navigates" you to a
  // list whose visible page does not contain the row it just sent you to.
  assert.equal(pageContaining(rows(100), 'r60', 25), 3);
});

test('the boundaries land on the right side', () => {
  assert.equal(pageContaining(rows(100), 'r24', 25), 1);
  assert.equal(pageContaining(rows(100), 'r25', 25), 2);
});

test('a row that is not in the list has no page', () => {
  assert.equal(pageContaining(rows(10), 'nope', 25), null);
  assert.equal(pageContaining(rows(10), null, 25), null);
});

// ------------------------------------------------------- the row is not here ----

test('a row present in the visible list is not missing', () => {
  assert.equal(focusIsMissing('r1', rows(5)), false);
});

test('a row the current view does not contain is reported missing', () => {
  // The case that makes a deep link worse than no deep link: the app promised to take you to
  // something and then showed you a list without it, with nothing said.
  assert.equal(focusIsMissing('gone', rows(5)), true);
});

test('nothing is concluded while the list is still loading', () => {
  assert.equal(focusIsMissing('r1', [], { loaded: false }), false);
});

test('an empty loaded list DOES mean the row is not there', () => {
  assert.equal(focusIsMissing('r1', [], { loaded: true }), true);
});

test('with no focus there is nothing to be missing', () => {
  assert.equal(focusIsMissing(null, []), false);
});
