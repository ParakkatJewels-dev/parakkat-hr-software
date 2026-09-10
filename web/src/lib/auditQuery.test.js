import test from 'node:test';
import assert from 'node:assert/strict';
import { auditSearchFilter, fetchAuditPage } from './auditQuery.js';

test('audit searches quote punctuation and literal wildcard characters', () => {
  assert.equal(auditSearchFilter('  '), '');
  assert.equal(auditSearchFilter('Alice'), 'actor_email.ilike."%Alice%",action.ilike."%Alice%",table_name.ilike."%Alice%"');
  const filter = auditSearchFilter('a,b_("x")%');
  assert.ok(filter.includes('a,b')); assert.ok(filter.includes('\\\\_')); assert.ok(filter.includes('\\"x\\"'));
});
test('audit history is counted, filtered and paged on the server, beyond the former 100-row ceiling', async () => {
  const calls = [];
  const query = Object.fromEntries(['select', 'order', 'or'].map((method) => [method, (...args) => { calls.push([method, ...args]); return query; }]));
  query.range = async (...range) => { calls.push(['range', ...range]); return { data: [{ id: 'older' }], count: 2500 }; };
  const result = await fetchAuditPage({ from: (table) => { assert.equal(table, 'audit_log'); return query; } }, { page: 7, pageSize: 25, search: 'Alice' });
  assert.deepEqual(result, { rows: [{ id: 'older' }], count: 2500 });
  assert.deepEqual(calls.at(-1), ['range', 150, 174]);
  assert.deepEqual(calls[0][2], { count: 'exact' });
  assert.deepEqual(calls.filter(([method]) => method === 'order').map((call) => call[1]), ['created_at', 'id']);
  assert.equal(calls.find(([method]) => method === 'or')[1], auditSearchFilter('Alice'));
});
