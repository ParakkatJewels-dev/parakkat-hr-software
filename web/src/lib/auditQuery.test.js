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
  const rows = Array.from({ length: 2500 }, (_, i) => ({ id: `entry-${i}` }));
  const client = { from(table) {
    assert.equal(table, 'audit_log');
    const request = [];
    calls.push(request);
    const query = Object.fromEntries(['select', 'order', 'or'].map(method => [method, (...args) => {
      request.push([method, ...args]); return query;
    }]));
    query.range = async (from, to) => {
      request.push(['range', from, to]);
      return { data: rows.slice(from, Math.min(to + 1, from + 7)), count: rows.length };
    };
    return query;
  } };
  const result = await fetchAuditPage(client, { page: 7, pageSize: 25, search: 'Alice' });
  assert.deepEqual(result, { rows: rows.slice(150, 175), count: 2500 });
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0].at(-1), ['range', 150, 174]);
  assert.deepEqual(calls[1].at(-1), ['range', 156, 174]);
  for (const request of calls) {
    assert.deepEqual(request[0][2], { count: 'exact' });
    assert.deepEqual(request.filter(([method]) => method === 'order').map(call => call.slice(1)), [
      ['created_at', { ascending: false }], ['id', { ascending: false }],
    ]);
    assert.equal(request.find(([method]) => method === 'or')[1], auditSearchFilter('Alice'));
  }
});
