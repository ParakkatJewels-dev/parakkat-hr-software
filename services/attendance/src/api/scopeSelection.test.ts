// The write-side scope rules must fail CLOSED.
//
//   npx tsx --test src/api/scopeSelection.test.ts
//
// A recompute rewrites attendance rows through a connection that bypasses RLS, so if these rules
// answer "everyone" where they meant "nobody", a grant over one branch drives an operation across
// the whole company. Each case below is one way that could happen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectionFor, narrow, type VisibleScope } from './scopeSelection';

const scope = (over: Partial<VisibleScope> = {}): VisibleScope => ({
  all: false,
  branchIds: [],
  entityIds: [],
  ...over,
});

test('ALL is reserved for the scopes that genuinely mean the whole organisation', () => {
  assert.deepEqual(selectionFor(scope({ all: true })), { kind: 'all', ids: null });
});

test('a super admin asking for specific employees gets exactly those, not everyone', () => {
  assert.deepEqual(selectionFor(scope({ all: true }), ['e1', 'e2']), { kind: 'all', ids: ['e1', 'e2'] });
});

// The line this whole module exists for. resolveVisibleScope contributes nothing for department and
// self grants, and the empty lists that leaves must mean nobody.
test('an empty scope is a refusal, never everyone', () => {
  assert.deepEqual(selectionFor(scope()), { kind: 'none' });
  assert.deepEqual(selectionFor(scope(), ['e1']), { kind: 'none' }, 'asking for someone does not grant them');
});

test('branch and entity grants are carried through to the query, and nothing else is', () => {
  assert.deepEqual(selectionFor(scope({ branchIds: ['b1'] })), {
    kind: 'branchesAndEntities',
    branchIds: ['b1'],
    entityIds: [],
  });
  assert.deepEqual(selectionFor(scope({ entityIds: ['ent1'] })), {
    kind: 'branchesAndEntities',
    branchIds: [],
    entityIds: ['ent1'],
  });
});

test('narrow() keeps only what is allowed', () => {
  assert.deepEqual(narrow(['a', 'b', 'c'], ['b']), ['b']);
  assert.deepEqual(narrow(['a', 'b'], ['b', 'zzz']), ['b'], 'an out-of-scope id is dropped');
  assert.deepEqual(narrow(['a', 'b'], ['zzz']), [], 'an entirely out-of-scope ask is a refusal');
});

test('narrow() with no request means the whole allowed set — and an empty set stays empty', () => {
  assert.deepEqual(narrow(['a', 'b']), ['a', 'b']);
  assert.deepEqual(narrow([]), [], 'no allowed employees must not become "no filter"');
  assert.deepEqual(narrow([], ['a']), []);
});
