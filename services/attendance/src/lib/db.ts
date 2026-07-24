// Single Prisma client for the process.
//
// This connects with the direct Postgres URL and therefore runs as a privileged role that bypasses
// RLS. That is deliberate and is the reason this service is never exposed to end users directly:
// it is a trusted background process with no user context, and it must read and write punches for
// every employee in every entity. Anything user-facing goes through Supabase/PostgREST, where the
// Role x Scope policies in 0007_rls.sql are enforced.
import { PrismaClient } from '@prisma/client';
import { logger } from './logger';
import { env, requireDatabaseUrl } from '../config/env';

const prismaLogLevels =
  env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace'
    ? ([
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ] as const)
    : ([
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ] as const);

export const prisma = new PrismaClient({
  log: prismaLogLevels as never,
  datasources: { db: { url: requireDatabaseUrl() } },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(prisma as any).$on('warn', (e: { message: string }) => logger.warn({ prisma: e.message }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(prisma as any).$on('error', (e: { message: string }) => logger.error({ prisma: e.message }));

if (env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma as any).$on('query', (e: { query: string; duration: number }) =>
    logger.debug({ durationMs: e.duration }, e.query)
  );
}

/** Verify the connection at boot so a bad DATABASE_URL fails immediately, not on first sync. */
export async function assertDbReachable(): Promise<void> {
  await prisma.$queryRaw`select 1`;
}

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect().catch((err) => logger.error({ err }, 'error disconnecting prisma'));
}

/**
 * Postgres serializes BigInt as-is, which JSON.stringify refuses to touch. raw_punches and
 * sync_runs both use bigint ids, so anything heading for JSON goes through here.
 */
export function jsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))
  ) as T;
}
