import { before, beforeEach, mock, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { backgroundJobs } from './jobs/background';

const calls: string[] = [];
const env = { NODE_ENV: 'test', BIOTIME_BASE_URL: 'http://fixture.invalid', APP_TIMEZONE: 'Asia/Kolkata', ENABLE_WORKERS: false, API_PORT: 0 };
let main: typeof import('./index').main;
let closeCallback: (() => void) | undefined;
const handlers = new Map<string, (...args: unknown[]) => void>();
let employeeSignal: AbortSignal | undefined;
let databaseWait: Promise<void> | undefined;

before(() => {
  mock.module(require.resolve('./config/env'), { namedExports: { env } });
  mock.module(require.resolve('./lib/logger'), { namedExports: { logger: { info() {}, warn() {}, error() {}, fatal() {} } } });
  mock.module(require.resolve('./lib/db'), { namedExports: {
    assertDbReachable: async () => { calls.push('database-ready'); await databaseWait; }, disconnectDb: async () => { calls.push('disconnect'); },
  } });
  mock.module(require.resolve('./api/server'), { namedExports: { createServer: () => { calls.push('create-api'); return ({ listen: () => ({
    close: (callback: () => void) => { calls.push('close-api'); closeCallback = callback; },
    closeAllConnections: () => { calls.push('force-close-api'); },
  }) }); } } });
  mock.module(require.resolve('./jobs/scheduler'), { namedExports: {
    startScheduler: () => { calls.push('start-scheduler'); }, stopScheduler: () => { calls.push('stop-scheduler'); }, jobsInFlight: () => [],
    exclusive: async (name: string, fn: (signal: AbortSignal) => Promise<unknown>) => {
      calls.push(`exclusive:${name}`); await fn(new AbortController().signal);
    },
  } });
  mock.module(require.resolve('./sync/runLog'), { namedExports: { reconcileStaleRuns: async () => { calls.push('reconcile-runs'); } } });
  mock.module(require.resolve('./jobs/commands'), { namedExports: { reconcileStaleCommands: async () => { calls.push('reconcile-commands'); } } });
  mock.module(require.resolve('./biotime/client'), { namedExports: { biotime: { ping: async () => { calls.push('ping'); return { ok: true }; } } } });
  mock.module(require.resolve('./sync/syncEmployees'), { namedExports: { syncEmployees: async (signal: AbortSignal) => {
    employeeSignal = signal; calls.push('sync-employees'); return { fetched: 675, created: 0 };
  } } });
  ({ main } = require('./index'));
});

beforeEach((t) => {
  const context = t as TestContext;
  calls.length = 0; handlers.clear(); employeeSignal = undefined; closeCallback = undefined; databaseWait = undefined;
  context.mock.method(process, 'on', (event: string, callback: (...args: unknown[]) => void) => { handlers.set(event, callback); return process; });
  context.mock.method(process, 'exit', ((code: number) => { calls.push(`exit:${code}`); }) as never);
});

test('shutdown aborts detached work and waits for its final operation before database disconnect', async (t) => {
  env.ENABLE_WORKERS = false;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let signal: AbortSignal | undefined;
  const work = backgroundJobs.start('backfill', async value => { signal = value; await held; });
  await main();
  handlers.get('SIGTERM')?.();
  closeCallback?.();
  try {
    assert.equal(signal?.aborted, true);
    t.mock.timers.tick(1000);
    await Promise.resolve();
    assert.ok(!calls.includes('disconnect'), 'an accepted detached job is still using the database');
  } finally { release(); await work; }
  t.mock.timers.tick(1000);
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(backgroundJobs.inFlight(), []);
  assert.ok(calls.includes('disconnect'));
  assert.ok(calls.includes('exit:0'));
});

test('API-only startup cannot reconcile or run work owned by a separate worker', async () => {
  env.ENABLE_WORKERS = false;
  await main();
  assert.ok(!calls.includes('reconcile-runs'));
  assert.ok(!calls.includes('reconcile-commands'));
  assert.ok(!calls.includes('ping'));
  assert.ok(!calls.includes('sync-employees'));
});

test('startup roster sync shares the scheduler lock and receives its cancellation signal', async () => {
  env.ENABLE_WORKERS = true;
  await main();
  assert.ok(calls.indexOf('reconcile-runs') < calls.indexOf('start-scheduler'));
  assert.ok(calls.indexOf('reconcile-commands') < calls.indexOf('start-scheduler'));
  assert.ok(calls.includes('exclusive:sync:employees'));
  assert.ok(employeeSignal instanceof AbortSignal);
});

test('shutdown lets an active HTTP request finish before disconnecting its database', async (t) => {
  env.ENABLE_WORKERS = false;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  await main();
  handlers.get('SIGTERM')?.();
  await Promise.resolve();
  assert.ok(calls.includes('close-api'));
  assert.ok(!calls.includes('disconnect'), 'the database must remain open while the response is being written');
  closeCallback?.();
  t.mock.timers.tick(1000);
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(calls.includes('disconnect'));
  assert.ok(calls.includes('exit:0'));
});

test('a shutdown while the initial database probe is pending cannot start workers afterwards', async () => {
  env.ENABLE_WORKERS = true;
  let release!: () => void;
  databaseWait = new Promise<void>((resolve) => { release = resolve; });
  const boot = main();
  try {
    assert.ok(handlers.has('SIGTERM'), 'shutdown must be installed before waiting on startup I/O');
    handlers.get('SIGTERM')?.();
    release();
    await boot;
    assert.ok(!calls.includes('create-api'));
    assert.ok(!calls.includes('start-scheduler'));
    assert.ok(!calls.includes('sync-employees'));
  } finally { release(); await boot; }
});
