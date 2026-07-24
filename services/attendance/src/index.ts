// Service entry point: the API server plus the scheduled workers, in one supervised process.
//
// They are deliberately together. Splitting them would mean two deployments, two health checks and
// two sets of credentials for a workload that is a couple of HTTP calls a minute. Set
// ENABLE_WORKERS=false to run an API-only replica if that ever changes.
import { env } from './config/env';
import { logger } from './lib/logger';
import { assertDbReachable, disconnectDb } from './lib/db';
import { createServer } from './api/server';
import { startScheduler, stopScheduler, jobsInFlight } from './jobs/scheduler';
import { biotime } from './biotime/client';

async function main(): Promise<void> {
  logger.info(
    {
      env: env.NODE_ENV,
      biotime: env.BIOTIME_BASE_URL,
      timezone: env.APP_TIMEZONE,
      workers: env.ENABLE_WORKERS,
    },
    'starting Parakkat attendance service'
  );

  // Fail fast on a bad database URL rather than discovering it on the first sync.
  await assertDbReachable();
  logger.info('database reachable');

  // BioTime being down at boot is NOT fatal — the terminals may be on a site that is offline, and
  // the worker's whole job is to survive that and catch up. Log it and carry on.
  const ping = await biotime.ping();
  if (ping.ok) {
    logger.info({ authMode: ping.mode }, 'BioTime reachable');
  } else {
    logger.warn({ error: ping.error }, 'BioTime not reachable at startup — the worker will keep retrying');
  }

  const app = createServer();
  const server = app.listen(env.API_PORT, () => {
    logger.info({ port: env.API_PORT }, 'API listening');
  });

  startScheduler();

  // --- graceful shutdown ------------------------------------------------------
  // Stop taking new work, let anything in flight finish, then close cleanly. Killing a worker
  // mid-sync is safe (the cursor only advances on success) but finishing is tidier and avoids a
  // pointless re-read of the same window on restart.
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'shutting down');
    stopScheduler();
    server.close();

    const deadline = Date.now() + 30_000;
    while (jobsInFlight().length > 0 && Date.now() < deadline) {
      logger.info({ jobs: jobsInFlight() }, 'waiting for jobs to finish');
      await new Promise((r) => setTimeout(r, 1_000));
    }

    if (jobsInFlight().length > 0) {
      logger.warn({ jobs: jobsInFlight() }, 'jobs still running at the deadline — exiting anyway');
    }

    await disconnectDb();
    logger.info('shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // A crash loop that restarts cleanly beats a process left in an unknown state, so these exit
  // and let the supervisor restart us.
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'unhandled promise rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    process.exit(1);
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
