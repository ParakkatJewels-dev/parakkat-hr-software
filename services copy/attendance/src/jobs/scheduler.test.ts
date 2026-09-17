// The deadline is the fix for a real outage: a transactions run started at 13:18, hung inside a
// socket that a network change had quietly killed, and held the "one run at a time" lock until
// somebody restarted the service the next morning. Sixteen hours of punches did not sync and the
// only symptom was a warning line every two minutes.
//
//   npx tsx --test src/jobs/scheduler.test.ts
import { before, mock, test } from 'node:test';
import cron from 'node-cron';
import assert from 'node:assert/strict';
let exclusive: typeof import('./scheduler').exclusive;
let JOB_DEADLINE_MS: typeof import('./scheduler').JOB_DEADLINE_MS;
let jobsInFlight: typeof import('./scheduler').jobsInFlight;
let stopScheduler: typeof import('./scheduler').stopScheduler;

before(() => {
  mock.module(require.resolve('../config/env'), { namedExports: { env: { APP_TIMEZONE: 'Asia/Kolkata', ENABLE_WORKERS: true } } });
  mock.module(require.resolve('../lib/logger'), { namedExports: { logger: { info() {}, warn() {}, error() {} } } });
  const idle = async () => {};
  mock.module(require.resolve('../sync/syncTransactions'), { namedExports: { syncTransactions: idle, catchUpTransactions: idle } });
  mock.module(require.resolve('../sync/syncEmployees'), { namedExports: { syncEmployees: idle } });
  mock.module(require.resolve('../engine/recompute'), { namedExports: { recompute: idle, drainRecomputeQueue: idle } });
  mock.module(require.resolve('../sync/runLog'), { namedExports: { pruneRuns: idle, expireOverdueRuns: idle } });
  mock.module(require.resolve('./commands'), { namedExports: { drainServiceCommands: idle, expireStaleCommands: idle } });
  ({ exclusive, JOB_DEADLINE_MS, jobsInFlight, stopScheduler } = require('./scheduler'));
});

test('the patched UUID dependency can create and run an explicitly stopped cron task', () => {
  let ran = 0;
  const task = cron.schedule('*/2 * * * *', () => { ran++; }, { scheduled: false });
  try {
    // No timer or worker starts: exercise the public task object returned by node-cron 3.
    (task as unknown as { now: () => void }).now();
    assert.equal(ran, 1);
  } finally { task.stop(); }
});

test('a second tick is skipped while the first is still running', async () => {
  let started = 0;
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });

  const first = exclusive('t:overlap', async () => { started += 1; await held; });
  await new Promise((r) => setImmediate(r));
  await exclusive('t:overlap', async () => { started += 1; });

  assert.equal(started, 1, 'the second tick did not start a second run');
  release();
  await first;
});

test('the lock is released once the run finishes, so the next tick runs', async () => {
  let runs = 0;
  await exclusive('t:sequential', async () => { runs += 1; });
  await exclusive('t:sequential', async () => { runs += 1; });
  assert.equal(runs, 2);
});

test('a job that throws still releases the lock', async () => {
  await exclusive('t:throws', async () => { throw new Error('boom'); });
  let ran = false;
  await exclusive('t:throws', async () => { ran = true; });
  assert.equal(ran, true, 'a failed run must not wedge the job forever');
});

test('a synchronous startup throw is caught and releases the same job for the next tick', async () => {
  await exclusive('t:sync-throw', () => { throw new Error('synchronous fixture failure'); });
  let ran = false;
  await exclusive('t:sync-throw', async () => { ran = true; });
  assert.equal(ran, true);
});

test('a hung job is aborted at its deadline and the lock is freed', async () => {
  // The real deadlines are minutes long, so borrow the slot with a short one for the test.
  const name = 't:hangs';
  JOB_DEADLINE_MS[name] = 60;

  let sawAbort = false;
  // A job that never settles on its own — exactly the black-holed-socket case.
  const hung = exclusive(name, (signal) =>
    new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => { sawAbort = true; resolve(); }, { once: true });
    })
  );

  await hung;
  assert.equal(sawAbort, true, 'the job was told to abort');

  let recovered = false;
  await exclusive(name, async () => { recovered = true; });
  assert.equal(recovered, true, 'the next tick could run — this is what did not happen in production');
});

test('a job that ignores the abort entirely still frees the lock', async () => {
  const name = 't:ignores-signal';
  JOB_DEADLINE_MS[name] = 60;

  // The worst case, and the one that actually happened: the hang is inside a socket read that
  // never looks at the signal. Aborting cannot make that read return, so `exclusive` must stop
  // waiting on it. If it merely awaited the job, this call would never resolve and the assertion
  // below would never be reached.
  await exclusive(name, () => new Promise<void>(() => {}));

  let recovered = false;
  await exclusive(name, async () => { recovered = true; });
  assert.equal(recovered, true, 'the schedule kept running despite a permanently hung job');
});

test('a job abandoned at the deadline cannot kill the process later', async () => {
  const name = 't:rejects-after-abandon';
  JOB_DEADLINE_MS[name] = 50;

  let sawUnhandled: unknown = null;
  const onUnhandled = (reason: unknown) => { sawUnhandled = reason; };
  process.on('unhandledRejection', onUnhandled);

  // Abandoned at 50ms, rejects at 150ms. index.ts exits the process on an unhandled rejection, so
  // an abandoned job that fails later must still have its rejection caught.
  await exclusive(name, () => new Promise<void>((_, reject) => {
    setTimeout(() => reject(new Error('late failure after abandonment')), 150);
  }));

  await new Promise((r) => setTimeout(r, 300));
  process.off('unhandledRejection', onUnhandled);

  assert.equal(sawUnhandled, null, 'the late rejection was handled, not left to crash the service');
});

test('shutdown aborts in-flight work and keeps abandoned work visible until it settles', async () => {
  const name = 't:shutdown-abandoned';
  JOB_DEADLINE_MS[name] = 10;
  let finish!: () => void;
  const held = new Promise<void>((resolve) => { finish = resolve; });
  const deadlineRun = exclusive(name, () => held);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await deadlineRun;
  assert.ok(jobsInFlight().includes(name), 'abandoning the deadline must not conceal live work from shutdown');
  const active = exclusive('t:shutdown-active', (signal) => new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  }));
  await new Promise((resolve) => setImmediate(resolve));
  stopScheduler();
  finish();
  await active;
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!jobsInFlight().includes(name));
  assert.ok(!jobsInFlight().includes('t:shutdown-active'));
});
