import test from 'node:test';
import assert from 'node:assert/strict';
import {
  grossComponentsFromNotes,
  normalizeGrossComponentsDraft,
  otherGrossFromTotal,
  parseMoneyDraft,
  salaryNotesFromGrossComponents,
  totalGrossComponentsDraft,
  totalGrossFromParts,
} from './salaryDraft.js';

test('blank money drafts are treated as absent, not zero', () => {
  assert.equal(parseMoneyDraft(''), null);
  assert.equal(parseMoneyDraft('   '), null);
});

test('gross total is basic plus the differentiated gross amount', () => {
  assert.equal(totalGrossFromParts('12000', '3500'), '15500');
  assert.equal(totalGrossFromParts('12000', ''), '12000');
});

test('gross component rows are named amounts and roll into gross', () => {
  const rows = [
    { name: 'HRA', amount: '3500' },
    { name: 'Travel allowance', amount: '750.50' },
    { name: '', amount: '' },
  ];
  assert.equal(totalGrossComponentsDraft(rows), '4250.5');
  assert.equal(totalGrossFromParts('12000', rows), '16250.5');
});

test('gross component validation requires name and amount together', () => {
  assert.equal(
    normalizeGrossComponentsDraft([{ name: '', amount: '500' }]).error,
    'Enter a gross name for every gross amount.'
  );
  assert.equal(
    normalizeGrossComponentsDraft([{ name: 'HRA', amount: '' }]).error,
    'Enter the amount for HRA.'
  );
});

test('gross component names round trip through salary notes', () => {
  const notes = salaryNotesFromGrossComponents([{ name: 'HRA', amount: '3500' }]);
  assert.deepEqual(grossComponentsFromNotes(notes, 12000, 15500), [{ name: 'HRA', amount: '3500' }]);
});

test('existing salary rows can show the other gross portion', () => {
  assert.equal(otherGrossFromTotal(12000, 15500), '3500');
  assert.deepEqual(grossComponentsFromNotes(null, 12000, 15500), [{ name: 'Other gross', amount: '3500' }]);
});
