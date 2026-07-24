// Health and status.
//
// /health is unauthenticated and deliberately cheap — it is what pm2, systemd and any uptime
// monitor poll. /api/status is the authenticated, detailed view behind the admin screen.
import { Router } from 'express';
import { prisma, jsonSafe } from '../../lib/db';
import { biotime } from '../../biotime/client';
import { env } from '../../config/env';
import { recentRuns } from '../../sync/runLog';
import { authenticate, requirePermission } from '../auth';
import { jobsInFlight } from '../../jobs/scheduler';

export const healthRouter = Router();

const startedAt = Date.now();

/**
 * Liveness + readiness in one.
 *
 * Returns 503 when the database is unreachable or the punch sync has not succeeded for a long
 * time — the second condition is the one that matters operationally, because the process can be
 * perfectly alive while silently failing to collect any attendance.
 */
healthRouter.get('/health', async (_req, res) => {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};
  let healthy = true;

  try {
    await prisma.$queryRaw`select 1`;
    checks.database = { ok: true };
  } catch (err) {
    checks.database = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    healthy = false;
  }

  try {
    const state = await prisma.syncState.findUnique({ where: { key: 'transactions' } });
    const lastSuccess = state?.lastSuccessAt ?? null;
    const ageMinutes = lastSuccess ? Math.round((Date.now() - lastSuccess.getTime()) / 60_000) : null;

    // Generous threshold: 30 minutes of failure is a real outage, but a couple of missed 2-minute
    // ticks during a BioTime restart should not page anyone.
    const stale = ageMinutes === null || ageMinutes > 30;

    checks.punchSync = {
      ok: !stale,
      detail: lastSuccess
        ? `last success ${ageMinutes} min ago${state?.consecutiveFailures ? `, ${state.consecutiveFailures} consecutive failures` : ''}`
        : 'never completed a sync',
    };

    if (stale && env.ENABLE_WORKERS) healthy = false;
  } catch (err) {
    checks.punchSync = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    healthy = false;
  }

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    workersEnabled: env.ENABLE_WORKERS,
    jobsInFlight: jobsInFlight(),
    checks,
  });
});

/** Everything the admin status page shows. */
healthRouter.get('/api/status', authenticate, requirePermission('device.manage', 'attendance.manage'), async (_req, res) => {
  const [state, runs, deviceRows, counts, biotimePing] = await Promise.all([
    prisma.syncState.findMany(),
    recentRuns(25),
    prisma.device.findMany({ orderBy: { lastPunchAt: 'desc' }, take: 50 }),
    prisma.$queryRaw<Array<{ metric: string; value: bigint }>>`
      select 'punches_total'      as metric, count(*)::bigint as value from public.raw_punches
      union all
      select 'punches_unmapped',  count(*)::bigint from public.raw_punches where employee_id is null
      union all
      select 'punches_today',     count(*)::bigint from public.raw_punches
        where punch_time >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'
      union all
      select 'codes_unmatched',   count(*)::bigint from public.biotime_employees
        where link_status in ('unmatched','ambiguous')
      union all
      select 'recompute_pending', count(*)::bigint from public.attendance_recompute_queue
        where processed_at is null
    `,
    biotime.ping(),
  ]);

  const metrics: Record<string, number> = {};
  for (const row of counts) metrics[row.metric] = Number(row.value);

  res.json(
    jsonSafe({
      biotime: { url: biotime.baseUrl, reachable: biotimePing.ok, authMode: biotimePing.mode, error: biotimePing.error },
      syncState: state,
      recentRuns: runs,
      devices: deviceRows,
      metrics,
      schedules: {
        transactions: env.SYNC_TRANSACTIONS_CRON,
        employees: env.SYNC_EMPLOYEES_CRON,
        engine: env.ENGINE_CRON,
      },
    })
  );
});
