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
import { reconcileStaleRuns } from './sync/runLog';
import { reconcileStaleCommands } from './jobs/commands';
import { biotime } from './biotime/client';
import { syncEmployees } from './sync/syncEmployees';

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

  // The database being down at boot is NOT fatal either: on the intended deployment (a laptop
  // that starts the service at logon) the network is often not up yet, and a crash here would
  // burn through pm2's restart budget and leave the service permanently 'errored'. Wait for it.
  for (let attempt = 1; ; attempt++) {
    try {
      await assertDbReachable();
      break;
    } catch (err) {
      logger.warn(
        { attempt, err: err instanceof Error ? err.message : String(err) },
        'database not reachable yet — retrying in 15s (is the internet up?)'
      );
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
  logger.info('database reachable');

  // Listen BEFORE probing BioTime: the probe can take minutes against a firewalled host, and
  // the API (health checks, exports) must not wait on it.
  const app = createServer();
  const server = app.listen(env.API_PORT, () => {
    logger.info({ port: env.API_PORT }, 'API listening');
  });

  // BioTime being down at boot is NOT fatal — the terminals may be on a site that is offline, and
  // the worker's whole job is to survive that and catch up. Log it and carry on.
  void biotime.ping().then((ping) => {
    if (ping.ok) {
      logger.info({ authMode: ping.mode }, 'BioTime reachable');
    } else {
      logger.warn({ error: ping.error }, 'BioTime not reachable at startup — the worker will keep retrying');
    }
  });

  // Anything still marked 'running' belongs to a previous process that did not shut down cleanly.
  // Settle it before scheduling, so the health endpoint never shows a phantom sync in progress.
  void reconcileStaleRuns().catch((err) =>
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'could not reconcile stale sync runs')
  );
  // A command stuck on 'running' blocks every future request of that kind, because the duplicate
  // guard treats it as still in flight.
  void reconcileStaleCommands().catch((err) =>
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'could not reconcile stale commands')
  );

  startScheduler();

  // Pull the device roster once at boot (fire-and-forget): without this, biotime_employees stays
  // empty until the 01:15 cron and HR has nothing to map on day one.
  if (env.ENABLE_WORKERS) {
    void syncEmployees()
      .then((r) => logger.info({ fetched: r.fetched, created: r.created }, 'startup roster sync done'))
      .catch((err) =>
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'startup roster sync failed — the nightly job will retry')
      );
  }

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
    console.error('FATAL unhandled rejection:', reason); // pretty transport may not flush first
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    console.error('FATAL uncaught exception:', err);
    process.exit(1);
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  console.error('FATAL failed to start:', err);
  process.exit(1);
});
