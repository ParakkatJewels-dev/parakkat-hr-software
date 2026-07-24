// The single HTTP surface onto BioTime. Everything else in the service goes through this.
//
// Responsibilities, in the order they matter:
//   1. attach the right Authorization header (Token or JWT — see auth.ts)
//   2. on 401, re-authenticate once and replay the request; a second 401 is a real failure
//   3. retry transient transport failures with backoff, so a BioTime restart is a pause not an outage
//   4. walk paginated endpoints lazily, so a 400k-row backfill never sits in memory at once
import axios, { AxiosInstance, AxiosRequestConfig, AxiosError } from 'axios';
import { env, requireBiotimeConfig } from '../config/env';
import { logger } from '../lib/logger';
import { withRetry, isRetryable } from '../lib/retry';
import { BiotimeAuth, createAuthHttp } from './auth';
import { pageItems, type BiotimePage } from './types';

export class BiotimeApiError extends Error {
  readonly status?: number;
  readonly url?: string;
  readonly body?: unknown;

  constructor(message: string, opts: { status?: number; url?: string; body?: unknown } = {}) {
    super(message);
    this.name = 'BiotimeApiError';
    this.status = opts.status;
    this.url = opts.url;
    this.body = opts.body;
  }
}

export interface PaginateOptions {
  pageSize?: number;
  /** Stop after this many pages. Undefined = walk to the end. */
  maxPages?: number;
  signal?: AbortSignal;
  /** Called after each page — used for progress logging on long backfills. */
  onPage?: (info: { page: number; received: number; total?: number }) => void;
}

export class BiotimeClient {
  // Built on first use, not in the constructor. The module-level singleton below is imported by
  // the API routes, and a missing BIOTIME_* var should surface as a clear error from the call
  // that needed it — not as an exception thrown while loading a module.
  private httpInstance: AxiosInstance | null = null;
  private authInstance: BiotimeAuth | null = null;

  private get http(): AxiosInstance {
    if (!this.httpInstance) {
      this.httpInstance = axios.create({
        baseURL: requireBiotimeConfig().baseUrl,
        timeout: env.BIOTIME_TIMEOUT_MS,
        headers: { Accept: 'application/json' },
        // BioTime can return a large page; keep axios from truncating it.
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
    }
    return this.httpInstance;
  }

  get auth(): BiotimeAuth {
    if (!this.authInstance) {
      this.authInstance = new BiotimeAuth(createAuthHttp());
    }
    return this.authInstance;
  }

  get baseUrl(): string {
    return env.BIOTIME_BASE_URL || '(not configured)';
  }

  /**
   * GET with auth, one automatic re-auth on 401, and backoff on transient errors.
   * `absoluteUrl` is used when following BioTime's own `next` links, which come back fully qualified.
   */
  async get<T>(path: string, params?: Record<string, unknown>, opts: { signal?: AbortSignal; absoluteUrl?: boolean } = {}): Promise<T> {
    return withRetry(
      async () => {
        const send = async (): Promise<T> => {
          const config: AxiosRequestConfig = {
            params,
            signal: opts.signal,
            headers: { Authorization: await this.auth.authorizationHeader() },
            // We handle 401 ourselves rather than letting axios throw, so the replay stays readable.
            validateStatus: (s) => (s >= 200 && s < 300) || s === 401,
          };

          const response = opts.absoluteUrl
            ? await this.http.get(path, { ...config, baseURL: undefined })
            : await this.http.get(path, config);

          if (response.status === 401) {
            return { __unauthorized: true } as unknown as T;
          }
          return response.data as T;
        };

        let data = await send();

        // One re-auth + replay. A token expiring mid-sync is routine on JWT builds.
        if ((data as { __unauthorized?: boolean })?.__unauthorized) {
          logger.info({ path }, '401 from BioTime — re-authenticating and retrying once');
          this.auth.invalidate();
          await this.auth.login();
          data = await send();

          if ((data as { __unauthorized?: boolean })?.__unauthorized) {
            throw new BiotimeApiError(
              `BioTime returned 401 twice for ${path}. The credentials authenticate but lack ` +
                `permission for this endpoint — check the API user's role in BioTime.`,
              { status: 401, url: path }
            );
          }
        }

        return data;
      },
      {
        retries: env.BIOTIME_MAX_RETRIES,
        label: `biotime.get ${path}`,
        signal: opts.signal,
        shouldRetry: (err) => {
          // Never retry a 401 here — that path is handled above and a retry loop on bad
          // credentials risks locking the BioTime account.
          const status = (err as AxiosError)?.response?.status;
          if (status === 401 || status === 403) return false;
          return isRetryable(err);
        },
      }
    );
  }

  /**
   * Walk a paginated endpoint, yielding one page of items at a time.
   *
   * Uses explicit `page` numbers rather than following `next`, because BioTime's `next` URL is
   * built from its own configured hostname, which on a LAN install is frequently unreachable from
   * this box (it hands back http://localhost:8090/... or an internal DNS name).
   */
  async *paginate<T>(
    path: string,
    params: Record<string, unknown> = {},
    opts: PaginateOptions = {}
  ): AsyncGenerator<T[], void, undefined> {
    const pageSize = opts.pageSize ?? env.BIOTIME_PAGE_SIZE;
    const maxPages = opts.maxPages ?? Infinity;

    let page = 1;
    let seen = 0;
    let total: number | undefined;

    while (page <= maxPages) {
      if (opts.signal?.aborted) {
        logger.warn({ path, page }, 'pagination aborted');
        return;
      }

      const body = await this.get<BiotimePage<T>>(
        path,
        { ...params, page, page_size: pageSize },
        { signal: opts.signal }
      );

      const items = pageItems(body);
      total = typeof body?.count === 'number' ? body.count : total;
      seen += items.length;

      opts.onPage?.({ page, received: items.length, total });

      if (items.length > 0) {
        yield items;
      }

      // Stop when the page came back short, or we've read everything BioTime said existed.
      const isLastPage = items.length < pageSize || (typeof total === 'number' && seen >= total);
      if (isLastPage) return;

      page += 1;
    }

    if (page > maxPages) {
      logger.warn({ path, maxPages, seen, total }, 'stopped paginating at maxPages — more records remain');
    }
  }

  /** Collect every page into one array. Only for small endpoints (terminals, employees). */
  async getAll<T>(path: string, params: Record<string, unknown> = {}, opts: PaginateOptions = {}): Promise<T[]> {
    const out: T[] = [];
    for await (const batch of this.paginate<T>(path, params, opts)) {
      out.push(...batch);
    }
    return out;
  }

  /** Cheap reachability + credentials check, used by `npm run doctor` and the health endpoint. */
  async ping(): Promise<{ ok: boolean; mode: string | null; error?: string }> {
    try {
      await this.auth.login();
      await this.get('/personnel/api/employees/', { page: 1, page_size: 1 });
      return { ok: true, mode: this.auth.mode };
    } catch (err) {
      return {
        ok: false,
        mode: this.auth.mode,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/** Process-wide client. BioTime is a single upstream; one token cache is what we want. */
export const biotime = new BiotimeClient();
