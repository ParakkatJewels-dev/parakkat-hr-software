// Executes the production orchestration and SQL against a new, private PostgreSQL cluster.
// Configuration is mocked before imports, so this never opens or reads the service .env.
import { after, before, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

const postgresAvailable = spawnSync('initdb', ['--version'], { stdio: 'ignore' }).status === 0;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let directory: string;
let client: PrismaClient;
let engine: typeof import('./recompute');
const runStatuses: string[] = [];
let serviceDisconnect: (() => Promise<void>) | undefined;

before(async () => {
  if (!postgresAvailable) return;
  directory = mkdtempSync('/tmp/hr-engine-fixture-');
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  execFileSync('initdb', ['-D', join(directory, 'data'), '-A', 'trust', '-U', 'engine_fixture', '--no-locale', '--encoding=UTF8'], { stdio: 'pipe' });
  execFileSync('pg_ctl', ['-D', join(directory, 'data'), '-l', join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${directory}`, '-w', 'start'], { stdio: 'pipe' });
  const url = `postgresql://engine_fixture@127.0.0.1:${port}/postgres`;
  client = new PrismaClient({ datasources: { db: { url } } });
  const psql = (path: string) => execFileSync('psql', ['-h', '127.0.0.1', '-p', String(port), '-U', 'engine_fixture', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', path], { stdio: 'pipe' });
  psql(join(__dirname, 'recompute.fixture.sql'));
  psql(join(__dirname, '../../../..', 'web/backend/supabase/migrations/0126_recompute_queue_generations.sql'));
  mock.module(require.resolve('../config/env'), { namedExports: {
    env: { APP_TIMEZONE: 'Asia/Kolkata', BIOTIME_TIMEZONE: 'Asia/Kolkata', LOG_LEVEL: 'error', NODE_ENV: 'test', PUNCH_DEDUPE_SECONDS: 60 },
    requireDatabaseUrl: () => url,
  } });
  mock.module(require.resolve('../lib/logger'), { namedExports: { logger: { info() {}, error() {}, warn() {} } } });
  const actualTime = require('../lib/time') as typeof import('../lib/time');
  mock.module(require.resolve('../lib/time'), { namedExports: { ...actualTime, todayWorkDate: () => '2026-07-15' } });
  mock.module(require.resolve('../sync/runLog'), { namedExports: { SyncRun: { start: async () => ({
    counters: {}, addDetail() {}, finish: async (status: string) => { runStatuses.push(status); },
  }) } } });
  engine = require('./recompute') as typeof import('./recompute');
  serviceDisconnect = (require('../lib/db') as typeof import('../lib/db')).disconnectDb;
});

beforeEach(async () => {
  if (!postgresAvailable) return;
  runStatuses.length = 0;
  await client.$executeRawUnsafe('truncate employees, shifts, employee_shift_assignments, raw_punches, attendance, attendance_regularizations, leaves, attendance_recompute_queue');
  await client.$executeRaw`update race_control set enabled = false`;
  await client.$executeRaw`insert into shifts(id, code, name, start_time, end_time, crosses_midnight, is_default)
    values (${id(1000)}::uuid, 'DAY', 'Fixture day', '09:00', '17:00', false, true)`;
  await client.$executeRaw`insert into employees(id, entity_id) values (${id(1)}::uuid, ${id(2000)}::uuid)`;
});

after(async () => {
  await serviceDisconnect?.();
  await client?.$disconnect();
  if (directory) {
    execFileSync('pg_ctl', ['-D', join(directory, 'data'), '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    rmSync(directory, { recursive: true, force: true });
  }
});

const fixtureTest = (name: string, fn: () => Promise<void>) => test(name, { skip: !postgresAvailable && 'PostgreSQL initdb is required for this isolated integration fixture' }, fn);

fixtureTest('ATT corrections persist complete endpoints, measured breaks and cleared exceptions through recompute SQL', async () => {
  await client.$executeRaw`update shifts set end_time = '17:30', break_minutes = 40,
    break_policy = 'excess', full_day_minutes = 510, is_flexible = true, weekly_offs = array[0]`;
  await client.$executeRaw`insert into employees(id, entity_id) values
    (${id(2)}::uuid, ${id(2000)}::uuid), (${id(3)}::uuid, ${id(2000)}::uuid)`;
  await client.$executeRaw`insert into raw_punches(employee_id, punch_time) values
    (${id(1)}::uuid, '2026-07-14 16:30+05:30'),
    (${id(2)}::uuid, '2026-07-14 09:00+05:30'),
    (${id(2)}::uuid, '2026-07-14 12:00+05:30'),
    (${id(2)}::uuid, '2026-07-14 13:30+05:30'),
    (${id(3)}::uuid, '2026-07-12 09:00+05:30')`;
  await client.$executeRaw`insert into attendance_regularizations(id, employee_id, work_date, check_in, check_out, status) values
    (${id(3001)}::uuid, ${id(1)}::uuid, '2026-07-14', '2026-07-14 09:00+05:30', null, 'Approved'),
    (${id(3002)}::uuid, ${id(2)}::uuid, '2026-07-14', null, '2026-07-14 17:30+05:30', 'Approved'),
    (${id(3003)}::uuid, ${id(3)}::uuid, '2026-07-12', null, '2026-07-12 11:00+05:30', 'Approved')`;
  await engine.recompute({ from: '2026-07-12', to: '2026-07-14' });
  const rows = await client.$queryRaw<Array<{
    employee_id: string; check_in: Date; check_out: Date; worked_minutes: number; break_minutes: number;
    is_missing_punch: boolean; breaks_incomplete: boolean; day_fraction: unknown; punch_count: number; ot_minutes: number;
  }>>`select employee_id, check_in, check_out, worked_minutes, break_minutes, is_missing_punch,
    breaks_incomplete, day_fraction, punch_count, ot_minutes from attendance
    where regularization_id is not null order by employee_id`;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => [r.worked_minutes, r.break_minutes, r.is_missing_punch, r.breaks_incomplete,
    Number(r.day_fraction), r.punch_count]), [[450, 0, false, false, 1, 1], [460, 90, false, false, 1, 3], [120, 0, false, false, 1, 1]]);
  assert.equal(rows[0]!.check_out.toISOString(), '2026-07-14T11:00:00.000Z');
  assert.equal(rows[1]!.check_out.toISOString(), '2026-07-14T12:00:00.000Z');
  assert.equal(rows[2]!.ot_minutes, 120);
});

fixtureTest('ATT-05: approved checkout-only night correction loads and persists its following-day exit', async () => {
  await client.$executeRaw`update shifts set start_time = '22:00', end_time = '06:00',
    crosses_midnight = true, break_minutes = 30, break_policy = 'fixed', full_day_minutes = 450`;
  await client.$executeRaw`insert into raw_punches(employee_id, punch_time)
    values (${id(1)}::uuid, '2026-07-14 22:00+05:30')`;
  await client.$executeRaw`insert into attendance_regularizations(id, employee_id, work_date, check_in, check_out, status)
    values (${id(3001)}::uuid, ${id(1)}::uuid, '2026-07-14', null, '2026-07-15 06:00+05:30', 'Approved')`;
  await engine.recompute({ from: '2026-07-14', to: '2026-07-14' });
  const rows = await client.$queryRaw<Array<{ check_out: Date; worked_minutes: number; is_missing_punch: boolean }>>`
    select check_out, worked_minutes, is_missing_punch from attendance`;
  assert.equal(rows[0]!.check_out.toISOString(), '2026-07-15T00:30:00.000Z');
  assert.equal(rows[0]!.worked_minutes, 450);
  assert.equal(rows[0]!.is_missing_punch, false);
});

fixtureTest('replacing an approved correction recalculates from its complete replacement and preserves device evidence', async () => {
  await client.$executeRaw`insert into raw_punches(employee_id, punch_time) values
    (${id(1)}::uuid, '2026-07-14 09:00+05:30'), (${id(1)}::uuid, '2026-07-14 17:00+05:30')`;
  await client.$executeRaw`insert into attendance_regularizations(id, employee_id, work_date, check_in, check_out, status)
    values (${id(3001)}::uuid, ${id(1)}::uuid, '2026-07-14', '2026-07-14 09:15+05:30', '2026-07-14 17:30+05:30', 'Approved')`;
  const recorded = await client.$queryRaw`select * from raw_punches order by id`;
  await engine.recompute({ from: '2026-07-14', to: '2026-07-14' });
  assert.deepEqual(await client.$queryRaw`select regularization_id, worked_minutes from attendance`,
    [{ regularization_id: id(3001), worked_minutes: 495 }]);

  // The direct HR RPC cancels the previous overlay and inserts the complete replacement in
  // one transaction. A null endpoint intentionally uses device evidence again, not old history.
  await client.$transaction([
    client.$executeRaw`update attendance_regularizations set status='Cancelled' where id=${id(3001)}::uuid`,
    client.$executeRaw`insert into attendance_regularizations(id, employee_id, work_date, check_in, check_out, status)
      values (${id(3002)}::uuid, ${id(1)}::uuid, '2026-07-14', null, '2026-07-14 18:00+05:30', 'Approved')`,
  ]);
  await engine.enqueueRecompute(id(1), '2026-07-14', '2026-07-14', 'HR correction replaced');
  assert.equal((await engine.drainRecomputeQueue())?.rowsWritten, 1);
  assert.deepEqual(await client.$queryRaw`select regularization_id, check_in, check_out, worked_minutes,
    is_missing_punch, source, status_override, punch_count, punches from attendance`, [{
    regularization_id: id(3002), check_in: new Date('2026-07-14T03:30:00Z'), check_out: new Date('2026-07-14T12:30:00Z'),
    worked_minutes: 540, is_missing_punch: false, source: 'regularized', status_override: null,
    punch_count: 2, punches: ['2026-07-14T03:30:00.000Z', '2026-07-14T11:30:00.000Z'],
  }]);
  assert.deepEqual(await client.$queryRaw`select * from raw_punches order by id`, recorded);
  assert.deepEqual(await client.$queryRaw`select status, check_in, check_out from attendance_regularizations where id=${id(3001)}::uuid`,
    [{ status: 'Cancelled', check_in: new Date('2026-07-14T03:45:00Z'), check_out: new Date('2026-07-14T12:00:00Z') }]);
  assert.equal(await engine.drainRecomputeQueue(), null);
});

fixtureTest('queue keeps future work pending and does not let future entries exhaust the batch', async () => {
  await engine.enqueueRecompute(id(1), '2026-07-16', '2026-07-18', 'Future approval');
  await engine.enqueueRecompute(id(1), '2026-07-14', '2026-07-14', 'Past correction');
  const summary = await engine.drainRecomputeQueue(1);
  assert.equal(summary?.rowsWritten, 1);
  const pending = await client.$queryRaw<Array<{ date: string }>>`select work_date::text as date from attendance_recompute_queue where processed_at is null order by work_date`;
  assert.deepEqual(pending.map(r => r.date), ['2026-07-16', '2026-07-17', '2026-07-18']);
  assert.equal(await engine.drainRecomputeQueue(), null, 'future-only queue is idle, not a failed run');
});

fixtureTest('a correction queued during recompute survives acknowledgment and is processed on the next drain', async () => {
  await engine.enqueueRecompute(id(1), '2026-07-14', '2026-07-14', 'Initial request');
  await client.$executeRaw`update race_control set enabled = true`;
  assert.equal((await engine.drainRecomputeQueue())?.rowsWritten, 1);
  const pending = await client.$queryRaw<Array<{ reason: string }>>`select reason from attendance_recompute_queue where processed_at is null`;
  assert.deepEqual(pending, [{ reason: 'Correction after data load' }]);
  assert.equal((await engine.drainRecomputeQueue())?.rowsWritten, 1);
  assert.equal(await engine.drainRecomputeQueue(), null);
});

fixtureTest('a regularization loader failure aborts before rewriting approved attendance', async () => {
  await client.$executeRaw`insert into attendance(employee_id, work_date, status, day_fraction) values (${id(1)}::uuid, '2026-07-14', 'Present', 1)`;
  await client.$executeRaw`alter table attendance_regularizations rename to unavailable_regularizations`;
  try {
    await assert.rejects(() => engine.recompute({ from: '2026-07-14', to: '2026-07-14' }));
    const rows = await client.$queryRaw<Array<{ status: string }>>`select status from attendance`;
    assert.deepEqual(rows, [{ status: 'Present' }]);
    assert.deepEqual(runStatuses, ['failed']);
  } finally {
    await client.$executeRaw`alter table unavailable_regularizations rename to attendance_regularizations`;
  }
});

fixtureTest('503 employees write exact attendance across multiple SQL chunks with locked and pre-hire rows protected', async () => {
  await client.$executeRaw`insert into employees(id, entity_id) select ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, ${id(2000)}::uuid from generate_series(2, 503) i`;
  await client.$executeRaw`update employees set join_date = '2026-07-14' where id = ${id(503)}::uuid`;
  await client.$executeRaw`insert into raw_punches(employee_id, punch_time)
    select id, stamp from employees cross join (values ('2026-07-13T03:30:00Z'::timestamptz), ('2026-07-13T11:30:00Z'::timestamptz), ('2026-07-14T03:30:00Z'::timestamptz), ('2026-07-14T11:30:00Z'::timestamptz)) v(stamp)`;
  await client.$executeRaw`insert into attendance(employee_id, work_date, status, day_fraction, worked_minutes, is_locked) values
    (${id(1)}::uuid, '2026-07-13', 'On Leave', 1, 0, true),
    (${id(503)}::uuid, '2026-07-13', 'Absent', 0, 0, false)`;
  const result = await engine.recompute({ from: '2026-07-13', to: '2026-07-14' });
  assert.equal(result.employees, 503);
  assert.equal(result.rowsWritten, 1004);
  assert.equal(result.skippedLocked, 1);
  const totals = await client.$queryRaw<Array<{ count: number; worked: number; present: number; locked: number }>>`select count(*)::int as count, sum(worked_minutes)::int as worked, count(*) filter (where status = 'Present')::int as present, count(*) filter (where is_locked)::int as locked from attendance`;
  assert.deepEqual(totals, [{ count: 1005, worked: 1004 * 480, present: 1004, locked: 1 }]);
  assert.deepEqual(await client.$queryRaw`select work_date::text as date from attendance where employee_id = ${id(503)}::uuid`, [{ date: '2026-07-14' }]);
});

fixtureTest('explicit empty employee scope performs no attendance writes', async () => {
  assert.equal((await engine.recompute({ from: '2026-07-14', to: '2026-07-14', employeeIds: [] })).rowsWritten, 0);
  assert.deepEqual(await client.$queryRaw`select * from attendance`, []);
});

fixtureTest('a first-day early assignment ignores the fictitious pre-join overnight default', async () => {
  await client.$executeRaw`update shifts set entity_id = ${id(2000)}::uuid,
    start_time = '22:00', end_time = '06:00', crosses_midnight = true`;
  await client.$executeRaw`update employees set join_date = '2026-07-14' where id = ${id(1)}::uuid`;
  await client.$executeRaw`insert into shifts(id, entity_id, code, name, start_time, end_time, crosses_midnight)
    values (${id(1001)}::uuid, ${id(2000)}::uuid, 'EARLY', 'First-day early shift', '05:00', '13:00', false)`;
  await client.$executeRaw`insert into employee_shift_assignments
    values (${id(1)}::uuid, ${id(1001)}::uuid, '2026-07-14', null)`;
  await client.$executeRaw`insert into employees(id, entity_id) values (${id(2)}::uuid, ${id(2000)}::uuid)`;
  await client.$executeRaw`insert into attendance(employee_id, work_date, status, worked_minutes, is_locked)
    values (${id(2)}::uuid, '2026-07-14', 'Present', 123, true)`;
  await client.$executeRaw`insert into raw_punches(employee_id, punch_time) values
    (${id(1)}::uuid, '2026-07-14 05:00+05:30'), (${id(1)}::uuid, '2026-07-14 13:00+05:30')`;
  const rawEvidence = await client.$queryRaw`select * from raw_punches order by id`;
  const protectedRows = await client.$queryRaw`select * from attendance where employee_id = ${id(2)}::uuid`;

  const result = await engine.recompute({ from: '2026-07-13', to: '2026-07-14', employeeIds: [id(1)] });
  assert.equal(result.employees, 1);
  assert.equal(result.rowsWritten, 1);
  assert.deepEqual(await client.$queryRaw`select work_date::text as date, shift_id, check_in, check_out,
    worked_minutes, punch_count, is_missing_punch from attendance where employee_id = ${id(1)}::uuid`, [{
    date: '2026-07-14', shift_id: id(1001), check_in: new Date('2026-07-13T23:30:00Z'),
    check_out: new Date('2026-07-14T07:30:00Z'), worked_minutes: 480, punch_count: 2, is_missing_punch: false,
  }]);
  assert.deepEqual(await client.$queryRaw`select * from attendance where employee_id = ${id(2)}::uuid`, protectedRows);
  assert.deepEqual(await client.$queryRaw`select * from raw_punches order by id`, rawEvidence);
});

fixtureTest('deactivating a shift does not erase attendance for its historical assignment', async () => {
  await client.$executeRaw`insert into shifts(id, code, name, start_time, end_time, crosses_midnight, is_active)
    values (${id(1001)}::uuid, 'OLD_NIGHT', 'Historical night', '22:00', '06:00', true, false)`;
  await client.$executeRaw`insert into employee_shift_assignments values (${id(1)}::uuid, ${id(1001)}::uuid, '2026-07-01', '2026-07-13')`;
  await client.$executeRaw`insert into raw_punches(employee_id, punch_time) values
    (${id(1)}::uuid, '2026-07-13T16:30:00Z'), (${id(1)}::uuid, '2026-07-14T00:30:00Z')`;
  await engine.recompute({ from: '2026-07-13', to: '2026-07-13' });
  assert.deepEqual(await client.$queryRaw`select status, worked_minutes, shift_id from attendance`,
    [{ status: 'Present', worked_minutes: 480, shift_id: id(1001) }]);
});

fixtureTest('month-boundary night rotation preserves break punches and gives identical results in separate day runs', async () => {
  await client.$executeRaw`update shifts set start_time = '09:30', end_time = '18:00', full_day_minutes = 510`;
  await client.$executeRaw`insert into shifts(id, code, name, start_time, end_time, crosses_midnight, is_active, full_day_minutes)
    values (${id(1001)}::uuid, 'OLD_NIGHT', 'Historical fixture night', '22:00', '06:00', true, false, 450)`;
  await client.$executeRaw`insert into employee_shift_assignments values (${id(1)}::uuid, ${id(1001)}::uuid, '2026-06-01', '2026-06-30')`;
  await client.$executeRaw`insert into raw_punches(employee_id, punch_time) values
    (${id(1)}::uuid, '2026-06-30 22:00+05:30'), (${id(1)}::uuid, '2026-07-01 00:30+05:30'),
    (${id(1)}::uuid, '2026-07-01 01:00+05:30'), (${id(1)}::uuid, '2026-07-01 06:00+05:30'),
    (${id(1)}::uuid, '2026-07-01 09:30+05:30'), (${id(1)}::uuid, '2026-07-01 18:00+05:30')`;
  await engine.recompute({ from: '2026-06-30', to: '2026-06-30' });
  await engine.recompute({ from: '2026-07-01', to: '2026-07-01' });
  const separate = await client.$queryRaw`select work_date::text, shift_id, status, worked_minutes, punch_count,
    break_minutes, is_missing_punch, punches from attendance order by work_date`;
  assert.deepEqual((separate as Array<Record<string, unknown>>).map(row => [row.work_date, row.shift_id,
    row.status, row.worked_minutes, row.punch_count, row.break_minutes, row.is_missing_punch]), [
    ['2026-06-30', id(1001), 'Present', 450, 4, 30, false],
    ['2026-07-01', id(1000), 'Present', 510, 2, 0, false],
  ]);
  await engine.recompute({ from: '2026-06-30', to: '2026-07-01' });
  assert.deepEqual(await client.$queryRaw`select work_date::text, shift_id, status, worked_minutes, punch_count,
    break_minutes, is_missing_punch, punches from attendance order by work_date`, separate);
});

fixtureTest('the following assignment outside a one-day recompute prevents the next arrival joining the night', async () => {
  await client.$executeRaw`update shifts set start_time = '22:00', end_time = '06:00', crosses_midnight = true`;
  await client.$executeRaw`insert into shifts(id, code, name, start_time, end_time, crosses_midnight)
    values (${id(1001)}::uuid, 'NEXT_DAY', 'Next fixture day', '09:00', '17:00', false)`;
  await client.$executeRaw`insert into employee_shift_assignments values (${id(1)}::uuid, ${id(1001)}::uuid, '2026-07-15', null)`;
  await client.$executeRaw`insert into raw_punches(employee_id, punch_time) values
    (${id(1)}::uuid, '2026-07-14 22:00+05:30'), (${id(1)}::uuid, '2026-07-15 06:00+05:30'),
    (${id(1)}::uuid, '2026-07-15 09:00+05:30'), (${id(1)}::uuid, '2026-07-15 17:00+05:30')`;
  await engine.recompute({ from: '2026-07-14', to: '2026-07-14' });
  assert.deepEqual(await client.$queryRaw`select worked_minutes, punch_count, is_missing_punch from attendance`,
    [{ worked_minutes: 480, punch_count: 2, is_missing_punch: false }]);
});

fixtureTest('a 09:00 to 09:30 change keeps an early-morning punch once at the shared cutover', async () => {
  await client.$executeRaw`insert into shifts(id, code, name, start_time, end_time, crosses_midnight)
    values (${id(1001)}::uuid, 'LATER', 'Later fixture day', '09:30', '18:00', false)`;
  await client.$executeRaw`insert into employee_shift_assignments values (${id(1)}::uuid, ${id(1001)}::uuid, '2026-07-14', null)`;
  await client.$executeRaw`insert into raw_punches(employee_id, punch_time) values
    (${id(1)}::uuid, '2026-07-13 17:00+05:30'), (${id(1)}::uuid, '2026-07-14 03:15+05:30'),
    (${id(1)}::uuid, '2026-07-14 09:30+05:30'), (${id(1)}::uuid, '2026-07-14 18:00+05:30')`;
  await engine.recompute({ from: '2026-07-13', to: '2026-07-14' });
  assert.deepEqual(await client.$queryRaw`select work_date::text, worked_minutes, punch_count from attendance order by work_date`, [
    { work_date: '2026-07-13', worked_minutes: 615, punch_count: 2 },
    { work_date: '2026-07-14', worked_minutes: 510, punch_count: 2 },
  ]);
});

fixtureTest('long night shifts widen the raw punch load beyond the standard query margin', async () => {
  await client.$executeRaw`update shifts set start_time = '23:00', end_time = '22:00', crosses_midnight = true`;
  await client.$executeRaw`insert into raw_punches(employee_id, punch_time) values
    (${id(1)}::uuid, '2026-07-13 23:00+05:30'), (${id(1)}::uuid, '2026-07-14 22:00+05:30')`;
  await engine.recompute({ from: '2026-07-13', to: '2026-07-13' });
  assert.deepEqual(await client.$queryRaw`select worked_minutes, punch_count, is_missing_punch from attendance`,
    [{ worked_minutes: 1380, punch_count: 2, is_missing_punch: false }]);
});

fixtureTest('assigned day and night scheduled breaks load and persist distinct paid/unpaid calculations', async () => {
  await client.$executeRaw`update shifts set end_time = '17:30', break_policy = 'scheduled', break_windows =
    '[{"label":"Tea","start_time":"11:00","end_time":"11:15","is_paid":true},
      {"label":"Lunch","start_time":"13:00","end_time":"13:30","is_paid":false}]'::jsonb`;
  await client.$executeRaw`insert into employees(id, entity_id) values (${id(2)}::uuid, ${id(2000)}::uuid)`;
  await client.$executeRaw`insert into shifts(id, code, name, start_time, end_time, crosses_midnight,
    break_policy, break_windows, full_day_minutes) values
    (${id(1001)}::uuid, 'NIGHT_BREAKS', 'Fixture night with breaks', '22:00', '06:00', true,
    'scheduled', '[{"label":"Paid tea","start_time":"23:45","end_time":"00:15","is_paid":true},
      {"label":"Meal","start_time":"02:00","end_time":"02:30","is_paid":false}]'::jsonb, 450)`;
  await client.$executeRaw`insert into employee_shift_assignments values (${id(2)}::uuid, ${id(1001)}::uuid, '2026-07-01', null)`;
  await client.$executeRaw`insert into raw_punches(employee_id, punch_time) values
    (${id(1)}::uuid, '2026-07-14 09:00+05:30'), (${id(1)}::uuid, '2026-07-14 17:30+05:30'),
    (${id(2)}::uuid, '2026-07-14 22:00+05:30'), (${id(2)}::uuid, '2026-07-14 23:40+05:30'),
    (${id(2)}::uuid, '2026-07-15 00:20+05:30'), (${id(2)}::uuid, '2026-07-15 06:00+05:30')`;
  await engine.recompute({ from: '2026-07-14', to: '2026-07-14' });
  assert.deepEqual(await client.$queryRaw`select employee_id, worked_minutes, break_minutes, is_long_break,
    is_missing_punch from attendance order by employee_id`, [
    { employee_id: id(1), worked_minutes: 480, break_minutes: 0, is_long_break: false, is_missing_punch: false },
    { employee_id: id(2), worked_minutes: 440, break_minutes: 40, is_long_break: true, is_missing_punch: false },
  ]);
});

fixtureTest('an overlapping rotation fails before attendance or leave writes and leaves recompute queued', async () => {
  await client.$executeRaw`insert into employees(id, entity_id) values (${id(2)}::uuid, ${id(2000)}::uuid)`;
  await client.$executeRaw`insert into shifts(id, code, name, start_time, end_time, crosses_midnight)
    values (${id(1001)}::uuid, 'OVERLAP', 'Conflicting fixture night', '22:00', '10:00', true)`;
  await client.$executeRaw`insert into employee_shift_assignments values (${id(2)}::uuid, ${id(1001)}::uuid, '2026-07-01', '2026-07-14')`;
  await client.$executeRaw`insert into attendance(employee_id, work_date, status, worked_minutes)
    values (${id(1)}::uuid, '2026-07-14', 'Present', 120)`;
  await client.$executeRaw`insert into raw_punches(employee_id, punch_time)
    values (${id(1)}::uuid, '2026-07-14 09:00+05:30')`;
  await client.$executeRaw`insert into leaves(id, employee_id, start_date, end_date, type, status, day_fraction)
    values (${id(4001)}::uuid, ${id(1)}::uuid, '2026-07-14', '2026-07-14', 'CL', 'Approved', 1)`;
  await engine.enqueueRecompute(null, '2026-07-14', '2026-07-14', 'Changed shifts');
  const service = (require('../lib/db') as typeof import('../lib/db')).prisma;
  const query = service.$queryRaw.bind(service);
  let leaveCancellations = 0;
  service.$queryRaw = (async (...args: Parameters<typeof query>) => {
    if (String(args[0]).includes('cancel_leave_day_for_punch')) leaveCancellations++;
    return query(...args);
  }) as typeof service.$queryRaw;
  try {
    await assert.rejects(() => engine.drainRecomputeQueue(), /Overlapping shift schedules between 2026-07-14 and 2026-07-15/);
    assert.deepEqual(await client.$queryRaw`select employee_id, worked_minutes from attendance`, [{ employee_id: id(1), worked_minutes: 120 }]);
    assert.equal(leaveCancellations, 0);
    assert.deepEqual(await client.$queryRaw`select count(*)::int as count from attendance_recompute_queue where processed_at is null`, [{ count: 1 }]);
  } finally {
    service.$queryRaw = query;
  }
});

fixtureTest('cancelling after the first write chunk prevents later writes and acknowledgment, and retry completes', async () => {
  await client.$executeRaw`insert into employees(id, entity_id) select ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, ${id(2000)}::uuid from generate_series(2, 503) i`;
  await engine.enqueueRecompute(null, '2026-07-14', '2026-07-14', 'All employees');
  const controller = new AbortController();
  const service = (require('../lib/db') as typeof import('../lib/db')).prisma;
  const execute = service.$executeRaw.bind(service);
  service.$executeRaw = (async (...args: Parameters<typeof execute>) => {
    const count = await execute(...args);
    if (String(args[0]).includes('insert into public.attendance')) controller.abort(new Error('Fixture cancelled'));
    return count;
  }) as typeof service.$executeRaw;
  try {
    await assert.rejects(() => engine.drainRecomputeQueue(5000, { signal: controller.signal }), /Fixture cancelled/);
    assert.deepEqual(await client.$queryRaw`select count(*)::int as count from attendance`, [{ count: 400 }]);
    assert.deepEqual(await client.$queryRaw`select count(*)::int as count from attendance_recompute_queue where processed_at is null`, [{ count: 1 }]);
  } finally {
    service.$executeRaw = execute;
  }
  assert.equal((await engine.drainRecomputeQueue())?.rowsWritten, 503);
  assert.deepEqual(await client.$queryRaw`select count(*)::int as count from attendance`, [{ count: 503 }]);
  assert.equal(await engine.drainRecomputeQueue(), null);
});

fixtureTest('concurrent recomputes load in order so an older snapshot cannot overwrite a correction', async () => {
  const service = (require('../lib/db') as typeof import('../lib/db')).prisma;
  const query = service.$queryRaw.bind(service);
  let releaseFirst: () => void = () => {};
  const firstMayContinue = new Promise<void>(resolve => { releaseFirst = resolve; });
  let firstLoaded: () => void = () => {};
  const firstHasLoaded = new Promise<void>(resolve => { firstLoaded = resolve; });
  let punchReads = 0;
  service.$queryRaw = (async (...args: Parameters<typeof query>) => {
    const rows = await query(...args);
    if (String(args[0]).includes('from public.raw_punches') && ++punchReads === 1) {
      firstLoaded();
      await firstMayContinue;
    }
    return rows;
  }) as typeof service.$queryRaw;
  try {
    const first = engine.recompute({ from: '2026-07-14', to: '2026-07-14' });
    await firstHasLoaded;
    await client.$executeRaw`insert into raw_punches(employee_id, punch_time) values
      (${id(1)}::uuid, '2026-07-14T03:30:00Z'), (${id(1)}::uuid, '2026-07-14T11:30:00Z')`;
    const second = engine.recompute({ from: '2026-07-14', to: '2026-07-14' });
    // Give the second call an event-loop turn; it must remain behind the older run's write.
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(punchReads, 1);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(await client.$queryRaw`select status, worked_minutes from attendance`, [{ status: 'Present', worked_minutes: 480 }]);
  } finally {
    releaseFirst();
    service.$queryRaw = query;
  }
});
