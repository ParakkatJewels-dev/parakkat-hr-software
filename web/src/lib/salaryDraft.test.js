import test from 'node:test';
import assert from 'node:assert/strict';
import { otherGrossFromTotal, parseMoneyDraft, totalGrossFromParts } from './salaryDraft.js';

test('blank money drafts are treated as absent, not zero', () => {
  assert.equal(parseMoneyDraft(''), null);
  assert.equal(parseMoneyDraft('   '), null);
});

test('gross total is basic plus the differentiated gross amount', () => {
  assert.equal(totalGrossFromParts('12000', '3500'), '15500');
  assert.equal(totalGrossFromParts('12000', ''), '12000');
});

test('existing salary rows can show the other gross portion', () => {
  assert.equal(otherGrossFromTotal(12000, 15500), '3500');
});
