// Real HTTP requests through Express; all external boundaries are deterministic local fixtures.
import { after, before, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AuthContext } from './auth';

const branchId = '00000000-0000-4000-8000-000000001002';
const users: Record<string, AuthContext> = {
  admin: { userId: 'admin', email: null, isSuperAdmin: true, permissions: [], employee: null },
  branch: { userId: 'branch', email: null, isSuperAdmin: false, permissions: [{ permission: 'device.manage', scope_type: 'branch', scope_id: branchId }], employee: null },
  self: { userId: 'self', email: null, isSuperAdmin: false, permissions: [{ permission: 'payslip.read', scope_type: 'self', scope_id: null }], employee: null },
};
const calls: Array<{ name: string; args?: unknown }> = [];
let failMappings = false;
let server: Server;
let baseUrl: string;

before(async () => {
  mock.module(require.resolve('../config/env'), {
    namedExports: { env: { SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_ANON_KEY: 'fixture', API_CORS_ORIGINS: ['https://hr.example.test'], APP_TIMEZONE: 'Asia/Kolkata', ENABLE_WORKERS: false }, canVerifyTokens: true },
  });
  mock.module(require.resolve('../lib/logger'), { namedExports: { logger: { info() {}, warn() {}, error() {} } } });
  mock.module(require.resolve('@supabase/supabase-js'), {
    namedExports: { createClient: (_url: string, _key: string, options: { global: { headers: { Authorization: string } } }) => {
      const user = users[options.global.headers.Authorization.slice(7)];
      return {
        auth: { getUser: async () => ({ data: { user: user ? { id: user.userId } : null }, error: null }) },
        rpc: async () => ({ data: { is_super_admin: user?.isSuperAdmin, permissions: user?.permissions }, error: null }),
      };
    } },
  });
  mock.module(require.resolve('../lib/db'), {
    namedExports: {
      jsonSafe: (value: unknown) => value,
      prisma: {
        $queryRaw: async (strings: TemplateStringsArray) => {
          if (strings.join('').includes("'punches_total'")) {
            calls.push({ name: 'status.metrics' });
            return [{ metric: 'punches_total', value: 503 }];
          }
          throw new Error('Unexpected database query in HTTP fixture');
        },
        syncState: { findMany: async () => { calls.push({ name: 'status.state' }); return []; } },
        device: { findMany: async () => { calls.push({ name: 'status.devices' }); return [{ id: 'other-company-device' }]; } },
        biotimeEmployee: {
          findMany: async (args: { take: number; skip?: number }) => {
            calls.push({ name: 'mapping.list', args });
            if (failMappings) throw new Error('Fixture database unavailable');
            return Array.from({ length: 503 }, (_, i) => ({ empCode: String(i + 1), linkStatus: 'unmatched' }))
              .slice(args.skip ?? 0, (args.skip ?? 0) + args.take);
          },
          count: async () => 503,
        },
      },
    },
  });
  mock.module(require.resolve('../biotime/client'), { namedExports: { biotime: { baseUrl: 'http://fixture-only.invalid', ping: async () => ({ ok: true }) } } });
  mock.module(require.resolve('../jobs/scheduler'), { namedExports: { jobsInFlight: () => [] } });
  mock.module(require.resolve('../sync/runLog'), { namedExports: { recentRuns: async () => [] } });
  const invoked = (name: string) => async (args: unknown) => { calls.push({ name, args }); return {}; };
  mock.module(require.resolve('../sync/syncTransactions'), { namedExports: { syncTransactions: invoked('sync'), catchUpTransactions: invoked('catchup'), runTransactionSync: invoked('backfill') } });
  mock.module(require.resolve('../sync/syncEmployees'), { namedExports: { syncEmployees: invoked('employees'), refreshSuggestions: invoked('suggestions'), resolvePunchLinks: invoked('link') } });
  mock.module(require.resolve('../engine/recompute'), { namedExports: { recompute: invoked('recompute'), drainRecomputeQueue: invoked('queue'), enqueueRecompute: invoked('enqueue') } });
  const { createServer } = require('./server') as typeof import('./server');
  server = createServer().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

beforeEach(() => { calls.length = 0; failMappings = false; });
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

const request = (path: string, user?: string, body?: unknown) => fetch(`${baseUrl}${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { ...(user ? { Authorization: `Bearer ${user}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body),
  signal: AbortSignal.timeout(2000),
});

test('anonymous and invalid sessions receive 401 without touching data', async () => {
  for (const user of [undefined, 'invalid']) {
    assert.equal((await request('/api/mapping', user)).status, 401);
  }
  assert.equal(calls.length, 0);
});

test('a branch manager cannot list, unlink or change the organisation-wide device roster', async () => {
  assert.equal((await request('/api/mapping', 'branch')).status, 403);
  assert.equal((await request('/api/mapping/link', 'branch', { empCode: '101', employeeId: null })).status, 403);
  assert.equal((await request('/api/mapping/suggest', 'branch', {})).status, 403);
  assert.equal((await request('/api/sync/transactions', 'branch', {})).status, 403);
  assert.equal(calls.length, 0);
});

test('self-only payslip permissions cannot download company payroll', async () => {
  assert.equal((await request('/api/exports/payroll?year=2026&month=7&format=json', 'self')).status, 403);
  assert.equal(calls.length, 0);
});

test('organisation-wide diagnostics are refused before reading telemetry for a scoped device manager', async () => {
  const denied = await request('/api/status', 'branch');
  assert.equal(denied.status, 403);
  assert.equal(calls.length, 0, 'no cross-company device rows or sync metrics were read');
  const allowed = await request('/api/status', 'admin');
  assert.equal(allowed.status, 200);
  assert.deepEqual((await allowed.json() as { devices: unknown[] }).devices, [{ id: 'other-company-device' }]);
});

test('invalid calendar dates and catch-up sizes are rejected before any work is queued', async () => {
  for (const date of ['2026-02-30', '2026-13-01', 'not-a-date']) {
    assert.equal((await request('/api/recompute', 'admin', { from: date })).status, 400);
    assert.equal((await request('/api/backfill', 'admin', { from: date })).status, 400);
  }
  for (const days of [-1, 0, 1.5, 91, 'wrong']) {
    assert.equal((await request('/api/sync/catchup', 'admin', { days })).status, 400);
  }
  assert.equal((await request('/api/recompute', 'admin', { from: '2026-07-15', employeeIds: [] })).status, 400);
  assert.equal(calls.length, 0);
});

test('valid leap-day requests and catch-up parameters reach the actual handler unchanged', async () => {
  assert.equal((await request('/api/recompute', 'admin', { from: '2024-02-29' })).status, 200);
  assert.equal((await request('/api/sync/catchup', 'admin', { days: 7 })).status, 202);
  assert.deepEqual(calls.map(({ name }) => name), ['recompute', 'catchup']);
  assert.equal((calls[0]?.args as { from: string }).from, '2024-02-29');
  assert.equal(calls[1]?.args, 7);
});

test('invalid report periods, branch identifiers and column keys receive 400', async () => {
  for (const query of ['year=2026&month=13', 'year=2026&month=7&branchIds=invalid', 'year=2026&month=7&columns=unknown&format=json']) {
    assert.equal((await request(`/api/exports/payroll?${query}`, 'admin')).status, 400, query);
  }
  assert.equal(calls.length, 0);
});

test('mapping pagination returns the final three of 503 employees with an exact total', async () => {
  const response = await request('/api/mapping?page=11&pageSize=50', 'admin');
  assert.equal(response.status, 200);
  const body = await response.json() as { rows: Array<{ empCode: string }>; total: number; pageCount: number; page: number };
  assert.equal(body.total, 503);
  assert.equal(body.page, 11);
  assert.equal(body.pageCount, 11);
  assert.deepEqual(body.rows.map((row) => row.empCode), ['501', '502', '503']);
  assert.equal((calls[0]?.args as { take: number }).take, 50);
});

test('unpaged mapping clients retain their array response and invalid page sizes are refused', async () => {
  const body = await (await request('/api/mapping', 'admin')).json();
  assert.ok(Array.isArray(body));
  assert.equal(body.length, 503);
  for (const query of ['page=0', 'page=1&pageSize=5000', 'status=not-a-status']) {
    assert.equal((await request(`/api/mapping?${query}`, 'admin')).status, 400);
  }
});

test('an async database failure becomes HTTP 500 and the server still answers the next request', async () => {
  failMappings = true;
  const failed = await request('/api/mapping?page=1', 'admin');
  assert.equal(failed.status, 500);
  assert.equal((await failed.json() as { error: string }).error, 'internal_error');
  failMappings = false;
  assert.equal((await request('/api/mapping?page=1', 'admin')).status, 200);
});

test('CORS allows the configured application and refuses an unrelated origin', async () => {
  for (const [origin, expected] of [['https://hr.example.test', 204], ['https://untrusted.example.test', 403]] as const) {
    const response = await fetch(`${baseUrl}/api/mapping`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Private-Network': 'true' } });
    assert.equal(response.status, expected);
    assert.equal(response.headers.get('Access-Control-Allow-Private-Network'), expected === 204 ? 'true' : null);
  }
});
