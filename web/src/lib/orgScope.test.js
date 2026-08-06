import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleOrg } from './orgScope.js';

// Two companies, to make "you should not see the other one" testable.
const ORG = {
  entities: [{ id: 'E1', name: 'PP Imitations' }, { id: 'E2', name: 'Pearls Head Office' }],
  zones: [{ id: 'Z1', entity_id: 'E1' }, { id: 'Z2', entity_id: 'E2' }],
  branches: [
    { id: 'B1', entity_id: 'E1', zone_id: 'Z1' },
    { id: 'B2', entity_id: 'E1', zone_id: 'Z1' },
    { id: 'B9', entity_id: 'E2', zone_id: 'Z2' },
  ],
  departments: [
    { id: 'D1', entity_id: 'E1', branch_id: 'B1' },
    { id: 'D2', entity_id: 'E1', branch_id: 'B2' },
    { id: 'D9', entity_id: 'E2', branch_id: 'B9' },
  ],
  designations: [{ id: 'T1', title: 'Sales Executive' }],
};

const ids = (rows) => rows.map((r) => r.id).sort();

test('a super admin sees the whole tree, untouched', () => {
  assert.equal(visibleOrg(ORG, [], true), ORG);
});

test('a global grant sees the whole tree', () => {
  assert.equal(visibleOrg(ORG, [{ scope_type: 'global', scope_id: null }]), ORG);
});

test('an entity grant sees that company and everything under it, and no other company', () => {
  const v = visibleOrg(ORG, [{ scope_type: 'entity', scope_id: 'E1' }]);
  assert.deepEqual(ids(v.entities), ['E1']);
  assert.deepEqual(ids(v.zones), ['Z1']);
  assert.deepEqual(ids(v.branches), ['B1', 'B2']);
  assert.deepEqual(ids(v.departments), ['D1', 'D2']);
});

test('a branch grant sees one branch and its departments — not its sibling', () => {
  const v = visibleOrg(ORG, [{ scope_type: 'branch', scope_id: 'B1' }]);
  assert.deepEqual(ids(v.branches), ['B1']);
  assert.deepEqual(ids(v.departments), ['D1']);
  // The company still appears, or the branch would have nothing to sit under on a form.
  assert.deepEqual(ids(v.entities), ['E1']);
  assert.deepEqual(ids(v.zones), []);
});

test('a zone grant cascades to the branches in that zone', () => {
  const v = visibleOrg(ORG, [{ scope_type: 'zone', scope_id: 'Z1' }]);
  assert.deepEqual(ids(v.zones), ['Z1']);
  assert.deepEqual(ids(v.branches), ['B1', 'B2']);
  assert.deepEqual(ids(v.entities), ['E1']);
});

test('a department grant sees only that department', () => {
  const v = visibleOrg(ORG, [{ scope_type: 'department', scope_id: 'D2' }]);
  assert.deepEqual(ids(v.departments), ['D2']);
  assert.deepEqual(ids(v.entities), ['E1']);
});

test('a self-scoped employee is offered no placement at all — not the whole group', () => {
  const v = visibleOrg(ORG, [{ scope_type: 'self', scope_id: null }]);
  assert.deepEqual(v.entities, []);
  assert.deepEqual(v.branches, []);
  assert.deepEqual(v.departments, []);
  assert.deepEqual(v.zones, []);
});

test('no grants at all is treated the same as self — empty, never everything', () => {
  const v = visibleOrg(ORG, []);
  assert.deepEqual(v.entities, []);
  assert.deepEqual(v.branches, []);
});

test('job titles stay whole — they are a vocabulary, not a place', () => {
  for (const grants of [[{ scope_type: 'branch', scope_id: 'B1' }], [{ scope_type: 'self' }], []]) {
    assert.deepEqual(visibleOrg(ORG, grants).designations, ORG.designations);
  }
});

test('grants combine rather than fight — a branch in each company shows both', () => {
  const v = visibleOrg(ORG, [
    { scope_type: 'branch', scope_id: 'B1' },
    { scope_type: 'branch', scope_id: 'B9' },
  ]);
  assert.deepEqual(ids(v.branches), ['B1', 'B9']);
  assert.deepEqual(ids(v.entities), ['E1', 'E2']);
});

test('a missing tree passes straight through instead of throwing', () => {
  assert.equal(visibleOrg(undefined, []), undefined);
  assert.equal(visibleOrg(null, []), null);
});
