import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const stubs = {
  '@tanstack/react-query': 'export const useQuery = x => x; export const useMutation = x => x; export const useQueryClient = () => ({ invalidateQueries: ({queryKey}) => { globalThis.ticketInvalidations.push(queryKey); } });',
  supabaseClient: 'export const supabase = { rpc: (...args) => globalThis.ticketDb.rpc(...args) };',
};
registerHooks({ resolve(specifier, context, next) {
  const key = specifier in stubs ? specifier : specifier.split('/').at(-1).replace(/\.js$/, '');
  if (stubs[key]) return { url: `data:text/javascript,${encodeURIComponent(stubs[key])}`, shortCircuit: true };
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(`${specifier}.js`, context.parentURL);
    if (existsSync(fileURLToPath(url))) return next(url.href, context);
  }
  return next(specifier, context);
} });
const tickets = await import('./tickets.js');
const categories = await import('./ticketCategories.js');

function pagedDb(rows, expectedRpc, failureAt) {
  const calls = [];
  globalThis.ticketDb = { rpc(name, args) {
    assert.equal(name, expectedRpc);
    const order = [];
    return {
      order(column) { order.push(column); return this; },
      range(start, end) {
        calls.push({ name, args, order, start });
        return Promise.resolve(start >= failureAt ? { error: new Error('Access changed') }
          : { data: rows.slice(start, Math.min(end + 1, start + 97)) });
      },
    };
  } };
  return calls;
}

test('routed ticket and category queries read every server page with deterministic ordering', async () => {
  const rows = Array.from({ length: 1205 }, (_, i) => ({ id: `row-${i}`, can_manage: i % 2 === 0 }));
  for (const [hook, rpc, firstOrder] of [[tickets.useTickets, 'list_tickets', 'created_at'], [categories.useTicketCategories, 'list_ticket_categories', 'name']]) {
    const calls = pagedDb(rows, rpc);
    assert.deepEqual(await hook().queryFn(), rows);
    assert.ok(calls.length > 12);
    assert.ok(calls.every(call => call.order.join(',') === `${firstOrder},id`));
  }
});

test('ticket routing fails visibly when a later page is refused', async () => {
  const rows = Array.from({ length: 1205 }, (_, i) => ({ id: `row-${i}` }));
  for (const [hook, rpc] of [[tickets.useTickets, 'list_tickets'], [categories.useTicketCategories, 'list_ticket_categories']]) {
    pagedDb(rows, rpc, 500);
    await assert.rejects(hook().queryFn(), /Access changed/);
  }
});

test('ticket creation sends the selected category and lets the server derive employee and department', async () => {
  const calls = [];
  globalThis.ticketDb = { rpc: async (name, args) => { calls.push({ name, args }); return { data: 'ticket-id', error: null }; } };
  assert.equal(await tickets.useAddTicket().mutationFn({ categoryId: 'category-it', subject: '  Laptop setup  ', description: '  Need VPN  ',
    priority: 'High', employee_id: 'spoofed-person', routed_department_id: 'spoofed-department' }), 'ticket-id');
  assert.deepEqual(calls, [{ name: 'create_ticket', args: { _category_id: 'category-it', _subject: 'Laptop setup', _description: 'Need VPN', _priority: 'High' } }]);
});

test('category mappings and HR queue metadata use the protected save RPC', async () => {
  const calls = [];
  globalThis.ticketDb = { rpc: async (name, args) => { calls.push({ name, args }); return { data: 'category-id', error: null }; } };
  await categories.useSaveTicketCategory().mutationFn({ id: 'category-id', name: ' Payroll ', departmentId: 'hr-department', isActive: false, isHrQueue: true });
  assert.deepEqual(calls, [{ name: 'save_ticket_category', args: { _id: 'category-id', _name: 'Payroll', _department_id: 'hr-department', _is_active: false, _is_hr_queue: true } }]);
});

test('server management refusals surface and successful mutations refresh both queues and action statuses', async () => {
  globalThis.ticketDb = { rpc: async () => ({ error: new Error('Ticket is outside the department you handle') }) };
  await assert.rejects(tickets.useSetTicketStatus().mutationFn({ id: 'ticket', status: 'Resolved' }), /outside the department/);
  globalThis.ticketInvalidations = [];
  await tickets.useSetTicketStatus().onSuccess();
  assert.deepEqual(globalThis.ticketInvalidations, [['tickets'], ['section-counts'], ['notification-ref-statuses']]);
  globalThis.ticketInvalidations = [];
  await categories.useSaveTicketCategory().onSuccess();
  assert.deepEqual(globalThis.ticketInvalidations, [['ticket-categories'], ['ticket-access'], ['tickets'], ['section-counts']]);
});

test('ticket access is provided by the server and missing category setup has an actionable error', async () => {
  const capabilities = { can_manage_categories: false, is_hr: true, can_view_queue: true };
  globalThis.ticketDb = { rpc: async (name) => { assert.equal(name, 'get_ticket_access'); return { data: capabilities }; } };
  assert.deepEqual(await categories.useTicketAccess().queryFn(), capabilities);
  globalThis.ticketDb = { rpc: () => ({ order() { return this; }, range: async () => ({ error: { code: 'PGRST202', message: 'Function missing from schema cache' } }) }) };
  await assert.rejects(categories.useTicketCategories().queryFn(), /Contact your administrator/);
});
