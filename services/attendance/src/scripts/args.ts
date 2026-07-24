// Minimal argv parsing for the CLI scripts. Deliberately dependency-free and strict about dates:
// a typo'd date silently backfilling the wrong month is worse than an error message.
import { DateTime } from 'luxon';
import { APP_TZ } from '../lib/time';

export type Args = Record<string, string | boolean>;

export function parseArgs(argv = process.argv.slice(2)): Args {
  const out: Args = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) continue;

    const [rawKey, inlineValue] = token.slice(2).split('=');
    const key = (rawKey ?? '').trim();
    if (!key) continue;

    if (inlineValue !== undefined) {
      out[key] = inlineValue;
      continue;
    }

    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }

  return out;
}

export function requireDate(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') {
    throw new Error(`--${key} is required (format YYYY-MM-DD)`);
  }
  return parseDate(value, key);
}

export function optionalDate(args: Args, key: string, fallback: string): string {
  const value = args[key];
  return typeof value === 'string' ? parseDate(value, key) : fallback;
}

export function parseDate(value: string, key = 'date'): string {
  const dt = DateTime.fromISO(value.trim(), { zone: APP_TZ });
  if (!dt.isValid) {
    throw new Error(`--${key} "${value}" is not a valid date (expected YYYY-MM-DD)`);
  }
  return dt.toFormat('yyyy-MM-dd');
}

export function flag(args: Args, key: string): boolean {
  return args[key] === true || args[key] === 'true';
}

export function num(args: Args, key: string, fallback: number): number {
  const value = args[key];
  if (typeof value !== 'string') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function list(args: Args, key: string): string[] {
  const value = args[key];
  if (typeof value !== 'string') return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}
