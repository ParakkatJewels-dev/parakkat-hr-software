import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchNotificationPage } from './notificationQuery.js';

function clientFor(rows, { cap = 1000, unreadError } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      assert.equal(table, 'notifications');
      const orders = [];
      let head = false, unreadOnly = false, from = 0, to = Infinity;
      const query = {
        select(_fields, options = {}) { assert.equal(options.count, 'exact'); head = Boolean(options.head); return query; },
        order(field, options) { orders.push([field, options.ascending]); return query; },
        is(field, value) { assert.equal(field, 'read_at'); assert.equal(value, null); unreadOnly = true; return query; },
        range(start, end) { from = start; to = end; return query; },
        then(resolve, reject) {
          calls.push({ head, from, to, orders });
          if (head && unreadError) return Promise.resolve({ error: unreadError }).then(resolve, reject);
          const all = rows.filter(row => !unreadOnly || !row.read_at).sort((a, b) => {
            for (const [key, ascending] of orders) {
              if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * (ascending ? 1 : -1);
            }
            return 0;
          });
          return Promise.resolve({ data: head ? null : all.slice(from, Math.min(to + 1, from + cap)), count: all.length }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

test('server notification paging reaches old history under a smaller API cap with global unread totals', async () => {
  const rows = Array.from({ length: 675 }, (_, i) => ({ id: `notification-${String(i).padStart(4, '0')}`,
    created_at: '2026-01-01T00:00:00Z', read_at: i % 3 === 0 ? null : '2026-01-02T00:00:00Z' }));
  const client = clientFor(rows, { cap: 7 });
  const final = await fetchNotificationPage(client, { page: 27, pageSize: 25 });
  assert.equal(final.count, 675);
  assert.equal(final.unreadCount, 225);
  assert.equal(final.rows.length, 25);
  assert.equal(final.rows[0].id, 'notification-0024');
  assert.equal(final.rows.at(-1).id, 'notification-0000');
  assert.equal(new Set(final.rows.map(row => row.id)).size, 25);
  assert.ok(client.calls.filter(call => !call.head).every(call => JSON.stringify(call.orders) === JSON.stringify([['created_at', false], ['id', false]])));
});

test('notification count errors are surfaced instead of claiming there are no unread notifications', async () => {
  await assert.rejects(fetchNotificationPage(clientFor([], { unreadError: new Error('Access changed') })), /Access changed/);
});
