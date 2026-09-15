import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequestBudget } from './rateLimit';

test('request quotas reject bursts and supply a decreasing retry time before resetting', () => {
  let now = 1000;
  const budget = new RequestBudget(2, () => now);
  assert.equal(budget.take('person-a', 2), 0);
  assert.equal(budget.take('person-a', 2), 0);
  now += 1500;
  assert.equal(budget.take('person-a', 2), 59);
  assert.equal(budget.take('person-b', 2), 0);
  now += 58500;
  assert.equal(budget.take('person-a', 2), 0);
});

test('rotating identities cannot evict a live quota or grow the key map', () => {
  let now = 1000;
  const budget = new RequestBudget(2, () => now);
  budget.take('first', 1); budget.take('second', 1);
  for (let i = 0; i < 100; i++) assert.equal(budget.take(`new-${i}`, 1), 60);
  assert.equal(budget.size, 2);
  assert.equal(budget.take('first', 1), 60);
  now += 60000;
  assert.equal(budget.take('new', 1), 0);
  assert.equal(budget.size, 1);
});
