// The single HTTP surface onto BioTime. Everything else in the service goes through this.
//
// Responsibilities, in the order they matter:
//   1. attach the right Authorization header (Token or JWT — see auth.ts)
//   2. on 401, re-authenticate once and replay the request; a second 401 is a real failure
//   3. retry transient transport failures with backoff, so a BioTime restart is a pause not an outage
//   4. walk paginated endpoints lazily, so a 400k-row backfill never sits in memory at once
import axios, { AxiosInstance, AxiosRequestConfig, AxiosError } from 'axios';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { env, requireBiotimeConfig } from '../config/env';
import { logger } from '../lib/logger';
import { withRetry, isRetryable } from '../lib/retry';
import { BiotimeAuth, createAuthHttp } from './auth';
import { pageItems, type BiotimePage } from './types';
import { enforceReadOnly } from './readOnly';
import { currentBaseUrl, rotateEndpoint, confirmEndpoint } from './endpoint';

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
  private httpAgent: HttpAgent | null = null;
  private httpsAgent: HttpsAgent | null = null;
  private authInstance: BiotimeAuth | null = null;

  private get http(): AxiosInstance {
    if (!this.httpInstance) {
      // Fresh agents, not Node's global ones. Owning the pool is what makes resetConnection()
      // possible: destroying a shared global agent would break every other caller in the process.
      const agentOpts = {
        keepAlive: true,
        // Idle sockets are cheap to re-open on a LAN and are the ones most likely to have died
        // quietly while nothing was using them. Recycling them often costs nothing here.
        keepAliveMsecs: 15_000,
        maxSockets: 8,
        timeout: env.BIOTIME_TIMEOUT_MS,
      };
      this.httpAgent = new HttpAgent(agentOpts);
      this.httpsAgent = new HttpsAgent(agentOpts);

      // Data calls only — not even the login goes through this instance.
      this.httpInstance = enforceReadOnly(axios.create({
        // Resolved, not configured: if the LAN address stops answering this follows the same
        // server to loopback rather than failing until somebody edits a file.
        baseURL: currentBaseUrl(),
        timeout: env.BIOTIME_TIMEOUT_MS,
        headers: { Accept: 'application/json' },
        httpAgent: this.httpAgent,
        httpsAgent: this.httpsAgent,
        // BioTime can return a large page; keep axios from truncating it.
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }));
    }
    return this.httpInstance;
  }

  /**
   * Drop the connection pool so the next request dials from scratch.
   *
   * `destroy()` on the agent tears down every pooled socket, including any that the OS still
   * believes are established but that lead nowhere after a network change. Clearing the axios
   * instance too means the next call through `get http()` builds a new agent as well.
   */
  resetConnection(): void {
    this.httpAgent?.destroy();
    this.httpsAgent?.destroy();
    this.httpAgent = null;
    this.httpsAgent = null;
    this.httpInstance = null;
    // The auth client holds its own baseURL, captured when it was built. Left alone, a rotation
    // would move the data calls to the new address while the login kept going to the dead one.
    this.authInstance = null;
    logger.warn('dropped the BioTime connection pool — the next request will reconnect');
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
          confirmEndpoint();
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

          // A transport failure means the connection pool may be holding sockets that are open as
          // far as this process is concerned and dead as far as the network is concerned — which is
          // exactly what a Wi-Fi/LAN switch or a rebooted terminal leaves behind. Retrying over the
          // same agent would reuse those corpses and hang again. Throw the agent away so the retry
          // dials fresh.
          if (!status) {
            // A transport failure may be this address rather than the server. Try the next route
            // to the same box before giving up on it.
            rotateEndpoint(err instanceof Error ? err.message : 'transport failure');
            this.resetConnection();
            this.auth.invalidate();
          }

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

      // Prefer the server's own `next` link when present — a server that caps page_size below
      // what we asked for returns "short" pages that are NOT the last page, and stopping on the
      // short-page heuristic alone would silently drop the rest of the window.
      const hasNextField = body != null && typeof body === 'object' && 'next' in body;
      const isLastPage =
        items.length === 0 ||
        (hasNextField ? body.next == null : items.length < pageSize) ||
        (typeof total === 'number' && seen >= total);
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
      const probe = await this.get<Record<string, unknown>>('/personnel/api/employees/', {
        page: 1,
        page_size: 1,
      });
      // A Django login page is a 200 with an HTML string — that must not count as "ok" or the
      // sync reports success forever while ingesting nothing.
      if (
        probe == null ||
        typeof probe !== 'object' ||
        (!('count' in probe) && !('data' in probe) && !('results' in probe))
      ) {
        return {
          ok: false,
          mode: this.auth.mode,
          error: 'the server answered with a non-JSON page — check that BIOTIME_BASE_URL points at Easy Time Pro / BioTime',
        };
      }
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
