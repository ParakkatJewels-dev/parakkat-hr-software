import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// waitingSince is a plain function; read it out of the module source so the test needs no React.
const source = readFileSync(new URL('./Approvals.jsx', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('export function waitingSince'), source.indexOf('export default function Approvals'));
const waitingSince = new Function(`${body.replace('export function', 'function')}; return waitingSince;`)();

test('a request says how long it has been waiting', () => {
  const now = new Date('2026-10-22T12:00:00Z');
  assert.equal(waitingSince('2026-10-22T08:00:00Z', now), 'Today');
  assert.equal(waitingSince('2026-10-21T09:00:00Z', now), 'Yesterday');
  assert.equal(waitingSince('2026-10-19T09:00:00Z', now), '3 days ago');
  assert.equal(waitingSince(null, now), '');
});

test('leave buttons open the review panel; corrections and expenses decide in place', () => {
  // Leave opens the review panel with the pressed button's decision already chosen.
  assert.match(source, /if \(tab\.id === 'leave'\) \{ setReviewIntent\(approve \? 'Approved' : 'Rejected'\); setReviewLeaveId\(row\.id\); \}/);
  assert.match(source, /initialDecision=\{reviewIntent\}/);
  assert.match(source, /setExpenseStatus\.mutate\(\{ id: row\.id, status: approve \? 'Approved' : 'Rejected', approverEmployeeId: employee\?\.id \}\)/);
  assert.match(source, /decideReg\.mutate\(\{ id: row\.id, decision: approve \? 'Approved' : 'Rejected' \}\)/);
});
