import test from 'node:test';
import assert from 'node:assert/strict';
import { balanceBar } from './leaveBalance.js';

test('a balance card shows used of total, the bar, and the days left the database keeps', () => {
  assert.deepEqual(balanceBar({ entitled: 18, carried_forward: 2, used: 12, available: 8 }), { total: 20, used: 12, left: 8, percent: 60 });
  assert.equal(balanceBar({ entitled: 10, used: 3, available: 5 }).left, 5, 'pending requests already count against the balance');
  assert.equal(balanceBar({ entitled: 0, used: 0, available: 0 }).percent, 0, 'no entitlement draws an empty bar');
  assert.equal(balanceBar({ entitled: 5, used: 9, available: 0 }).percent, 100, 'over-use stops at a full bar');
  assert.equal(balanceBar({ entitled: '12', used: '4' }).left, 8, 'falls back to total minus used');
});
