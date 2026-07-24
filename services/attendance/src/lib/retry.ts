// Exponential backoff with jitter, plus the classification of what is worth retrying.
//
// The distinction that matters: a network blip or a 502 from a restarting BioTime is transient and
// must be retried, but a 400 (bad query params) is a bug that will fail identically forever and
// should surface immediately instead of being masked by four slow retries.
import { logger } from './logger';

export class RetryableError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'RetryableError';
    this.cause = cause;
  }
}

/** Transport-level failures: BioTime restarting, the LAN dropping, DNS flapping. */
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

/** 408 timeout, 429 rate limit, and the whole 5xx family. */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 507, 509]);

export function isRetryable(err: unknown): boolean {
  if (err instanceof RetryableError) return true;

  const e = err as { code?: string; response?: { status?: number }; status?: number };
  if (e?.code && RETRYABLE_CODES.has(e.code)) return true;

  const status = e?.response?.status ?? e?.status;
  if (typeof status === 'number' && RETRYABLE_STATUSES.has(status)) return true;

  return false;
}

export interface RetryOptions {
  retries?: number;
  /** First delay, doubled each attempt. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Label for the log line, e.g. 'biotime.transactions'. */
  label?: string;
  /** Override the default classification. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  signal?: AbortSignal;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run `fn`, retrying transient failures with exponential backoff + full jitter.
 * Jitter matters here: without it, a worker and a backfill both recovering from the same BioTime
 * restart would retry in lockstep and hammer it back down.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const {
    retries = 4,
    baseDelayMs = 1_000,
    maxDelayMs = 60_000,
    label = 'operation',
    shouldRetry = isRetryable,
    signal,
  } = opts;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;

      if (attempt >= retries || !shouldRetry(err, attempt)) {
        throw err;
      }

      const exponential = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      const delay = Math.round(exponential / 2 + Math.random() * (exponential / 2));

      logger.warn(
        {
          label,
          attempt: attempt + 1,
          of: retries,
          delayMs: delay,
          err: err instanceof Error ? err.message : String(err),
        },
        `${label} failed, retrying`
      );

      await sleep(delay, signal);
    }
  }

  throw lastError;
}
