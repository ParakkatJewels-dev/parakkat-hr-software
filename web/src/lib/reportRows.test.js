import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headcountByBranch } from './reportRows.js';

test('headcount separates company branches, current roster, period movement and orphaned exit embeds', () => {
  const org = { entities: [{ id: 'a', code: 'A' }, { id: 'b', code: 'B' }], branches: [
    { id: 'a-hq', entity_id: 'a', code: 'HQ' }, { id: 'b-hq', entity_id: 'b', code: 'HQ' },
  ] };
  const employees = [
    { id: '1', entity_id: 'a', branch_id: 'a-hq', status: 'Active', join_date: '2099-01-01' },
    { id: '2', entity_id: 'b', branch_id: 'b-hq', status: 'Active', join_date: '2026-09-01' },
    { id: '3', entity_id: 'b', branch_id: 'b-hq', status: 'Inactive', join_date: '2026-09-02' },
  ];
  const exits = [{ branch_id: 'b-hq', entity_id: 'b', employee: null, last_day: '2026-09-15' },
    { branch_id: 'a-hq', entity_id: 'a', employee: null, last_day: '2026-08-31' }];
  const options = { from: '2026-09-01', to: '2026-09-30', org };
  assert.deepEqual(headcountByBranch(employees, exits, options), [
    { id: 'a-hq', label: 'A · HQ', active: 1, joiners: 0, exits: 0 },
    { id: 'b-hq', label: 'B · HQ', active: 1, joiners: 2, exits: 1 },
  ]);
  assert.deepEqual(headcountByBranch(employees, exits, { ...options, branchId: 'b-hq' }), [
    { id: 'b-hq', label: 'B · HQ', active: 1, joiners: 2, exits: 1 },
  ]);
});

test('unassigned employees from separate companies do not collapse when organization details are missing', () => {
  const rows = headcountByBranch([{ entity_id: 'a', status: 'Active' }, { entity_id: 'b', status: 'Active' }], [],
    { from: '2026-09-01', to: '2026-09-30', org: null });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.label), ['Unassigned (unassigned:a)', 'Unassigned (unassigned:b)']);
  assert.ok(rows.every(row => row.active === 1));
});
