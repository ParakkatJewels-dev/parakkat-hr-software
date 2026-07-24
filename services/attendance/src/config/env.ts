// Environment loading and validation. Fails fast and loudly at boot: a worker that starts with a
// bad BioTime URL and only discovers it two minutes later, mid-sync, is much harder to diagnose.
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { IANAZone } from 'luxon';

loadDotenv();

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v.toLowerCase() === 'true'));

const int = (def: number, min?: number, max?: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .refine((v) => Number.isFinite(v), { message: 'must be a number' })
    .refine((v) => (min === undefined ? true : v >= min), { message: `must be >= ${min}` })
    .refine((v) => (max === undefined ? true : v <= max), { message: `must be <= ${max}` });

const timezone = (def: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v))
    .refine((v) => IANAZone.isValidZone(v), { message: 'must be a valid IANA timezone' });

// Credentials are optional at PARSE time and asserted at USE time (see the require* helpers
// below). Booting the worker still fails fast, because index.ts touches both groups immediately —
// but computing a work date or running the pure attendance rules no longer requires a BioTime
// password, which keeps the engine testable in isolation.
const schema = z.object({
  DATABASE_URL: z.string().optional(),
  DIRECT_DATABASE_URL: z.string().optional(),

  BIOTIME_BASE_URL: z
    .string()
    .optional()
    .transform((v) => (v ? v.replace(/\/+$/, '') : '')),
  BIOTIME_USERNAME: z.string().optional().default(''),
  BIOTIME_PASSWORD: z.string().optional().default(''),
  BIOTIME_TIMEZONE: timezone('Asia/Kolkata'),
  BIOTIME_AUTH_MODE: z.enum(['auto', 'token', 'jwt']).default('auto'),
  BIOTIME_TIMEOUT_MS: int(30_000, 1_000),
  BIOTIME_MAX_RETRIES: int(4, 0, 10),
  BIOTIME_PAGE_SIZE: int(500, 1, 5_000),

  APP_TIMEZONE: timezone('Asia/Kolkata'),

  SYNC_TRANSACTIONS_CRON: z.string().default('*/2 * * * *'),
  SYNC_EMPLOYEES_CRON: z.string().default('15 1 * * *'),
  ENGINE_CRON: z.string().default('30 2 * * *'),
  ENGINE_LOOKBACK_DAYS: int(3, 0, 90),
  SYNC_OVERLAP_MINUTES: int(5, 0, 1_440),
  // Nightly re-scan window. A terminal that was offline uploads its stored punches later, with
  // their ORIGINAL punch_time — already behind the cursor, so the incremental poll can never see
  // them. Re-scanning the last few days catches those; the unique constraint makes it a no-op
  // when there is nothing new.
  SYNC_CATCHUP_DAYS: int(3, 0, 90),
  // How far back the very first sync reaches when no cursor exists yet.
  INITIAL_SYNC_LOOKBACK_DAYS: int(7, 0, 3_650),
  // Safety valve: pages per scheduled run, so one poll cannot run for an hour.
  SYNC_MAX_PAGES_PER_RUN: int(40, 1, 10_000),
  PUNCH_DEDUPE_SECONDS: int(60, 0, 3_600),

  API_PORT: int(8091, 1, 65_535),
  API_CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),

  SUPABASE_URL: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  ENABLE_WORKERS: bool(true),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // Deliberately console.error, not the logger: the logger itself reads this config.
  console.error(`\nInvalid environment configuration:\n${issues}\n\nSee .env.example.\n`);
  process.exit(1);
}

export const env = parsed.data;

/** The API can verify Supabase JWTs only if these are set; routes 503 otherwise. */
export const canVerifyTokens = Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY);

class ConfigError extends Error {
  constructor(missing: string[], purpose: string) {
    super(
      `Missing configuration for ${purpose}: ${missing.join(', ')}. ` +
        `Copy .env.example to .env and fill these in.`
    );
    this.name = 'ConfigError';
  }
}

/** Asserted where the database connection is built. */
export function requireDatabaseUrl(): string {
  if (!env.DATABASE_URL) throw new ConfigError(['DATABASE_URL'], 'the database');
  return env.DATABASE_URL;
}

/** Asserted where the BioTime client is built. */
export function requireBiotimeConfig(): { baseUrl: string; username: string; password: string } {
  const missing: string[] = [];
  if (!env.BIOTIME_BASE_URL) missing.push('BIOTIME_BASE_URL');
  if (!env.BIOTIME_USERNAME) missing.push('BIOTIME_USERNAME');
  if (!env.BIOTIME_PASSWORD) missing.push('BIOTIME_PASSWORD');
  if (missing.length) throw new ConfigError(missing, 'the BioTime connection');

  return {
    baseUrl: env.BIOTIME_BASE_URL,
    username: env.BIOTIME_USERNAME,
    password: env.BIOTIME_PASSWORD,
  };
}

export type Env = typeof env;
