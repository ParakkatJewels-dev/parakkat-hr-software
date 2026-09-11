// Seven seeded roles through real HTTP authentication, scope resolution and PostgreSQL report SQL.
// Supabase identity and operational side effects are fixtures; this creates its own local cluster.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createSocket } from 'node:net';
import type { Server } from 'node:http';
import { join, resolve } from 'node:path';
import { mock } from 'node:test';
import { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import type { AuthContext, Grant } from '../api/auth';

const id = (n: number) => `${Math.floor(n / 100)}0000000-0000-0000-0000-${String(n % 100).padStart(12, '0')}`;
const roleKeys = ['super_admin', 'entity_admin', 'hr_manager', 'zonal_manager', 'branch_manager', 'dept_head', 'employee'] as const;
type RoleKey = typeof roleKeys[number];
// Generated from a fresh replay of every application migration, including cumulative grants and
// the later removal of management access to colleagues' personal payslips/documents.
const catalogue = JSON.parse(readFileSync(resolve(__dirname, '../../../../web/src/test/standardRolePermissions.json'), 'utf8')) as
  Record<RoleKey, { rank: number; permissions: string[] }>;
const replay = JSON.parse(readFileSync(resolve(__dirname, '../../../../web/backend/tests/fixtures/standard-role-access.json'), 'utf8')) as {
  migrations: string[];
  actors: Array<{ key: string; userId: string; access: { is_super_admin: boolean; permissions: Grant[]; employee: AuthContext['employee'] } }>;
};
const scopeByRole: Record<RoleKey, [string, string | null]> = {
  super_admin: ['global', null], entity_admin: ['entity', id(101)], hr_manager: ['entity', id(101)],
  zonal_manager: ['zone', id(201)], branch_manager: ['branch', id(301)], dept_head: ['department', id(401)], employee: ['self', null],
};
const expectedByRole: Record<RoleKey, number[]> = {
  super_admin: [501, 502, 503, 504, 505, 506], entity_admin: [501, 502, 503, 504, 506], hr_manager: [501, 502, 503, 504, 506],
  zonal_manager: [501, 502, 503], branch_manager: [501, 502], dept_head: [], employee: [],
};
const people = [
  { id: id(501), branch: id(301), entity: id(101), department: id(401) },
  { id: id(502), branch: id(301), entity: id(101), department: id(402) },
  { id: id(503), branch: id(302), entity: id(101), department: id(403) },
  { id: id(504), branch: id(303), entity: id(101), department: id(404) },
  { id: id(505), branch: id(304), entity: id(102), department: id(405) },
  { id: id(506), branch: null, entity: id(101), department: null },
];
const grants = (permissions: string[], scope: [string, string | null]): Grant[] => permissions.map((permission) => ({ permission, scope_type: scope[0], scope_id: scope[1] }));
const users: Record<string, AuthContext | null> = {};
for (const role of roleKeys) {
  const actor = replay.actors.find((item) => item.key === role);
  assert.ok(actor, `missing migration-replayed actor ${role}`);
  users[role] = {
    userId: actor.userId, email: `${role}@fixture.invalid`, isSuperAdmin: actor.access.is_super_admin,
    permissions: actor.access.permissions, employee: actor.access.employee,
  };
}
users.unassigned = { userId: id(620), email: null, isSuperAdmin: false, permissions: [], employee: null };
users.missing_access = null;
users.unlinked_employee = { ...users.employee!, userId: id(621), employee: null };
users.mixed_manager = { ...users.hr_manager!, userId: id(622), permissions: [
  ...grants(catalogue.hr_manager.permissions, ['entity', id(101)]),
  ...grants(catalogue.hr_manager.permissions, ['branch', id(304)]),
] };
users.unrelated_global_grant = { ...users.branch_manager!, userId: id(623), permissions: [
  ...users.branch_manager!.permissions, { permission: 'device.manage', scope_type: 'global', scope_id: null },
] };

async function main() {
  const directory = mkdtempSync('/tmp/hr-attendance-roles-');
  const dataDirectory = join(directory, 'data');
  const socket = createSocket();
  await new Promise<void>((done) => socket.listen(0, '127.0.0.1', done));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((done) => socket.close(() => done()));
  let started = false;
  let database: PrismaClient | undefined;
  let server: Server | undefined;
  const calls: Array<{ name: string; args?: unknown }> = [];
  const summary: Array<Record<string, unknown>> = [];
  let requests = 0;
  try {
    execFileSync('initdb', ['-D', dataDirectory, '-A', 'trust', '-U', 'attendance_fixture', '--no-locale', '--encoding=UTF8'], { stdio: 'pipe' });
    execFileSync('pg_ctl', ['-D', dataDirectory, '-l', join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${directory}`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    const databaseUrl = `postgresql://attendance_fixture@127.0.0.1:${port}/postgres`;
    database = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const schema = [
      'create table entities (id uuid primary key, name text)',
      'create table branches (id uuid primary key, name text, entity_id uuid, zone_id uuid)',
      'create table departments (id uuid primary key, name text)',
      'create table designations (id uuid primary key, title text)',
      'create table employees (id uuid primary key, employee_code text, full_name text, entity_id uuid, branch_id uuid, department_id uuid, designation_id uuid, status text)',
      'create table biotime_employees (emp_code text primary key, employee_id uuid, link_status text)',
      'create table leaves (id uuid primary key, day_fraction numeric)',
      'create table raw_punches (employee_id uuid, punch_time timestamptz)',
      'create table attendance_recompute_queue (processed_at timestamptz)',
      `create table attendance (id bigint generated always as identity primary key, employee_id uuid, work_date date, status text, day_fraction numeric,
        is_lop boolean default false, leave_id uuid, ot_minutes int default 60, worked_minutes int default 510,
        is_late boolean default false, late_minutes int default 0, is_early_exit boolean default false, is_missing_punch boolean default false)`,
    ];
    for (const statement of schema) await database.$executeRawUnsafe(statement);
    await database.$executeRaw`insert into entities values (${id(101)}::uuid, 'Company A'), (${id(102)}::uuid, 'Company B')`;
    for (const [branch, entity, zone] of [[301, 101, 201], [302, 101, 201], [303, 101, 202], [304, 102, 203]]) {
      await database.$executeRaw`insert into branches values (${id(branch!)}::uuid, ${`Branch ${branch}`}, ${id(entity!)}::uuid, ${id(zone!)}::uuid)`;
    }
    for (const person of people) {
      const number = 500 + Number(person.id.slice(-12));
      await database.$executeRaw`insert into employees (id, employee_code, full_name, entity_id, branch_id, department_id, status)
        values (${person.id}::uuid, ${`E${number}`}, ${`Fixture ${number}`}, ${person.entity}::uuid, ${person.branch}::uuid, ${person.department}::uuid, 'Active')`;
      await database.$executeRaw`insert into attendance (employee_id, work_date, status, day_fraction) values (${person.id}::uuid, '2026-07-15', 'Present', 1)`;
    }

    mock.module(require.resolve('../config/env'), { namedExports: { canVerifyTokens: true, env: {
      DATABASE_URL: databaseUrl, SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_ANON_KEY: 'fixture',
      API_CORS_ORIGINS: ['https://fixture.invalid'], APP_TIMEZONE: 'Asia/Kolkata', ENABLE_WORKERS: false,
    } } });
    mock.module(require.resolve('../lib/logger'), { namedExports: { logger: { info() {}, warn() {}, error() {} } } });
    mock.module(require.resolve('@supabase/supabase-js'), { namedExports: {
      createClient: (_url: string, _key: string, options: { global: { headers: { Authorization: string } } }) => {
        const token = options.global.headers.Authorization.slice(7);
        const user = users[token];
        return {
          auth: { getUser: async () => ({ data: { user: token in users ? { id: user?.userId ?? id(624) } : null }, error: null }) },
          rpc: async () => ({ data: user ? { is_super_admin: user.isSuperAdmin, permissions: user.permissions, employee: user.employee } : null, error: null }),
        };
      },
    } });
    const invoke = (name: string) => async (args?: unknown) => { calls.push({ name, args }); return {}; };
    mock.module(require.resolve('../lib/db'), { namedExports: {
      jsonSafe: (value: unknown) => JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? Number(entry) : entry)),
      prisma: {
        $queryRaw: database.$queryRaw.bind(database),
        syncState: { findMany: async () => { calls.push({ name: 'status' }); return []; } },
        device: { findMany: async () => [{ id: 'company-a-device' }, { id: 'company-b-device' }] },
        biotimeEmployee: {
          findMany: async () => { calls.push({ name: 'mapping' }); return [{ empCode: 'fixture-device' }]; },
          count: async () => 1,
          findUnique: async () => ({ empCode: 'fixture-device', employeeId: null }),
          update: invoke('mapping.update'),
        },
        employee: { findUnique: async ({ where }: { where: { id: string } }) => people.find((person) => person.id === where.id) ?? null },
      },
    } });
    mock.module(require.resolve('../biotime/client'), { namedExports: { biotime: { baseUrl: 'http://fixture-only.invalid', ping: async () => ({ ok: true }) } } });
    mock.module(require.resolve('../jobs/scheduler'), { namedExports: { jobsInFlight: () => [] } });
    mock.module(require.resolve('../sync/runLog'), { namedExports: { recentRuns: async () => [] } });
    mock.module(require.resolve('../sync/syncTransactions'), { namedExports: { syncTransactions: invoke('sync'), catchUpTransactions: invoke('catchup'), runTransactionSync: invoke('backfill') } });
    mock.module(require.resolve('../sync/syncEmployees'), { namedExports: { syncEmployees: invoke('employees'), refreshSuggestions: invoke('suggestions'), resolvePunchLinks: async () => ({ punchesLinked: 0, firstDate: null, lastDate: null }) } });
    mock.module(require.resolve('../engine/recompute'), { namedExports: { recompute: invoke('recompute'), drainRecomputeQueue: invoke('queue'), enqueueRecompute: invoke('enqueue') } });
    const { createServer } = require('../api/server') as typeof import('../api/server');
    server = createServer().listen(0, '127.0.0.1');
    await new Promise<void>((done) => server!.once('listening', done));
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const request = async (path: string, user?: string, body?: unknown) => {
      requests++;
      return fetch(`${baseUrl}${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { ...(user ? { Authorization: `Bearer ${user}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000) });
    };
    const exportsPath = (kind: string, branch?: number) => `/api/exports/${kind}?year=2026&month=7&format=json${branch ? `&branchIds=${id(branch)}` : ''}`;
    const rowIds = (rows: Array<{ employeeId: string }>) => rows.map((row) => row.employeeId).sort();
    const adminActions: Array<[string, unknown, number]> = [
      ['/api/sync/transactions', {}, 200], ['/api/sync/employees', {}, 200], ['/api/sync/catchup', { days: 1 }, 202],
      ['/api/backfill', { from: '2026-07-15', to: '2026-07-15' }, 202], ['/api/recompute/queue', {}, 200],
      ['/api/mapping/suggest', {}, 200], ['/api/mapping/link', { empCode: 'fixture-device', employeeId: id(501) }, 200],
    ];
    for (const role of roleKeys) {
      const expected = expectedByRole[role].map(id).sort();
      const permitted = expected.length > 0;
      for (const kind of ['register', 'payroll']) {
        const response = await request(exportsPath(kind), role);
        assert.equal(response.status, permitted ? 200 : 403, `${role} ${kind} permission/scope`);
        if (permitted) {
          const body = await response.json() as { rows: Array<{ employeeId: string; payableDays?: number; otHours?: number; totals?: { payable: number; otHours: number } }> };
          assert.deepEqual(rowIds(body.rows), expected, `${role} ${kind} returns exactly authorised employees`);
          assert.ok(body.rows.every((row) => (row.payableDays ?? row.totals?.payable) === 1 && (row.otHours ?? row.totals?.otHours) === 1));
          const file = await request(`/api/exports/${kind}?year=2026&month=7&columns=employee_code,full_name,payable_days`, role);
          assert.equal(file.status, 200);
          const workbook = new ExcelJS.Workbook();
          await workbook.xlsx.load(Buffer.from(await file.arrayBuffer()) as never);
          const sheet = workbook.worksheets[0]!;
          const firstRow = kind === 'register' ? 5 : 4;
          const codes = expectedByRole[role].map((n) => `E${n}`).sort();
          assert.deepEqual(Array.from({ length: expected.length }, (_, index) => sheet.getRow(firstRow + index).getCell(1).value).sort(), codes);
        }
      }
      // Same-branch, same-zone/different-branch, different-zone and different-company boundaries.
      for (const kind of ['register', 'payroll']) {
        for (const branch of [301, 302, 303, 304]) {
          const expectedBranch = people.filter((person) => person.branch === id(branch) && expected.includes(person.id)).map((person) => person.id).sort();
          const response = await request(exportsPath(kind, branch), role);
          assert.equal(response.status, expectedBranch.length ? 200 : 403, `${role} ${kind} branch ${branch}`);
          if (expectedBranch.length) assert.deepEqual(rowIds((await response.json() as { rows: Array<{ employeeId: string }> }).rows), expectedBranch);
        }
      }
      const metadata = await request('/api/exports/payroll/columns', role);
      assert.equal(metadata.status, 200, 'all standard roles may read column definitions without any employee data');
      assert.ok((await metadata.json() as { columns: Array<{ key: string }> }).columns.some((column) => column.key === 'employee_code'));
      calls.length = 0;
      const recompute = await request('/api/recompute', role, { from: '2026-07-15', employeeIds: people.map((person) => person.id) });
      assert.equal(recompute.status, permitted ? 200 : 403, `${role} recompute`);
      if (permitted) assert.deepEqual((calls.find((call) => call.name === 'recompute')?.args as { employeeIds: string[] }).employeeIds.sort(), expected);
      else assert.equal(calls.length, 0);
      for (const employee of [501, 503, 504, 505]) {
        calls.length = 0;
        const canRecompute = expected.includes(id(employee));
        assert.equal((await request('/api/recompute', role, { from: '2026-07-15', employeeIds: [id(employee)] })).status,
          canRecompute ? 200 : 403, `${role} recompute employee ${employee} across branch/zone/company boundaries`);
        if (canRecompute) assert.deepEqual((calls.find((call) => call.name === 'recompute')?.args as { employeeIds: string[] }).employeeIds, [id(employee)]);
        else assert.equal(calls.length, 0);
      }
      calls.length = 0;
      const status = await request('/api/status', role);
      assert.equal(status.status, role === 'super_admin' ? 200 : 403, `${role} global diagnostics`);
      if (role === 'super_admin') assert.deepEqual((await status.json() as { devices: unknown[] }).devices, [{ id: 'company-a-device' }, { id: 'company-b-device' }]);
      else assert.equal(calls.length, 0, 'denied diagnostics must not load telemetry');
      assert.equal((await request('/api/mapping?page=1', role)).status, role === 'super_admin' ? 200 : 403, `${role} global mappings`);
      for (const [path, body, allowedStatus] of adminActions) {
        calls.length = 0;
        assert.equal((await request(path, role, body)).status, role === 'super_admin' ? allowedStatus : 403, `${role} ${path}`);
        if (role !== 'super_admin') assert.equal(calls.length, 0, 'denied management calls cannot schedule work');
      }
      summary.push({ role, scope: scopeByRole[role][0], exportedEmployees: expected.length, recompute: permitted, globalDiagnostics: role === 'super_admin', globalOperations: role === 'super_admin' });
    }
    for (const user of [undefined, 'invalid', 'unassigned', 'missing_access', 'unlinked_employee']) {
      for (const path of ['/api/status', '/api/mapping', exportsPath('register'), exportsPath('payroll')]) {
        assert.equal((await request(path, user)).status, !user || user === 'invalid' ? 401 : 403, `${user ?? 'anonymous'} ${path}`);
      }
      for (const [path, body] of [...adminActions, ['/api/recompute', { from: '2026-07-15' }, 200] as [string, unknown, number]]) {
        calls.length = 0;
        assert.equal((await request(path, user, body)).status, !user || user === 'invalid' ? 401 : 403, `${user ?? 'anonymous'} ${path}`);
        assert.equal(calls.length, 0);
      }
    }
    // Permission scope must come from this operation's own grants, even if another permission is global.
    const unrelated = await request(exportsPath('register'), 'unrelated_global_grant');
    assert.equal(unrelated.status, 200);
    assert.deepEqual(rowIds((await unrelated.json() as { rows: Array<{ employeeId: string }> }).rows), [id(501), id(502)]);
    // The union includes company staff without a branch, as well as the second granted branch.
    for (const kind of ['register', 'payroll']) {
      const mixed = await request(exportsPath(kind), 'mixed_manager');
      assert.equal(mixed.status, 200);
      assert.deepEqual(rowIds((await mixed.json() as { rows: Array<{ employeeId: string }> }).rows), people.map((person) => person.id).sort(), 'mixed grants retain branchless employees within an authorised entity');
    }
    calls.length = 0;
    assert.equal((await request('/api/recompute', 'super_admin', { from: '2026-07-15', employeeIds: [] })).status, 400, 'an empty explicit employee selection cannot become everyone');
    assert.equal(calls.length, 0);
    console.log(JSON.stringify({ ok: true, requests, roles: summary, replayedMigrations: replay.migrations.length, sql: 'actual PostgreSQL report and scope queries', identity: 'mocked Supabase verifier returning actual migration-replayed get_my_access grants', externalOperations: 'mocked; no workers or device calls' }, null, 2));
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((done) => server!.close(() => done()));
    }
    await database?.$disconnect();
    if (started) execFileSync('pg_ctl', ['-D', dataDirectory, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
