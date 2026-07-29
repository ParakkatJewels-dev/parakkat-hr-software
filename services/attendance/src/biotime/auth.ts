// BioTime authentication, covering both schemes in the wild.
//
//   older builds: POST /api-token-auth/      -> { token }  -> header  Authorization: Token <t>
//   newer builds: POST /jwt-api-token-auth/  -> { token }  -> header  Authorization: JWT <t>
//
// On newer builds the legacy route 404s, so we probe once and then cache which one worked. JWT
// tokens expire, which is handled by treating any 401 as "re-authenticate and retry once" rather
// than by tracking expiry — the server is the authority on whether a token is still good, and
// clock skew between this box and BioTime makes local expiry maths unreliable.
import axios, { AxiosInstance, AxiosError } from 'axios';
import { env, requireBiotimeConfig } from '../config/env';
import { logger } from '../lib/logger';
import { withRetry, isRetryable } from '../lib/retry';
import { enforceReadOnly } from './readOnly';
import { currentBaseUrl } from './endpoint';
import type { AuthMode, AuthResult } from './types';

const ROUTES: Record<AuthMode, string> = {
  token: '/api-token-auth/',
  jwt: '/jwt-api-token-auth/',
};

const HEADER_PREFIX: Record<AuthMode, string> = {
  token: 'Token',
  jwt: 'JWT',
};

export class BiotimeAuthError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'BiotimeAuthError';
    this.status = status;
  }
}

export class BiotimeAuth {
  private current: AuthResult | null = null;

  /** Sticky once discovered, so we stop probing the 404 route on every re-auth. */
  private discoveredMode: AuthMode | null =
    env.BIOTIME_AUTH_MODE === 'auto' ? null : (env.BIOTIME_AUTH_MODE as AuthMode);

  /** De-duplicates concurrent logins: 8 parallel page fetches must not trigger 8 logins. */
  private inFlight: Promise<AuthResult> | null = null;

  constructor(private readonly http: AxiosInstance) {}

  /** The Authorization header value, authenticating first if needed. */
  async authorizationHeader(): Promise<string> {
    const auth = this.current ?? (await this.login());
    return `${HEADER_PREFIX[auth.mode]} ${auth.token}`;
  }

  /** Drop the cached token. The next request re-authenticates. */
  invalidate(): void {
    if (this.current) {
      logger.debug({ mode: this.current.mode }, 'biotime token invalidated');
    }
    this.current = null;
  }

  get mode(): AuthMode | null {
    return this.current?.mode ?? this.discoveredMode;
  }

  get isAuthenticated(): boolean {
    return this.current !== null;
  }

  /** Authenticate, coalescing concurrent callers onto one request. */
  async login(): Promise<AuthResult> {
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.doLogin()
      .then((result) => {
        this.current = result;
        this.discoveredMode = result.mode;
        return result;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  private async doLogin(): Promise<AuthResult> {
    // An explicit BIOTIME_AUTH_MODE means "use exactly this" — probing the other scheme would
    // contradict the setting (and posts the credentials twice). 'auto' probes: known-good first,
    // otherwise legacy then JWT.
    const forced = env.BIOTIME_AUTH_MODE;
    const order: AuthMode[] =
      forced === 'token' || forced === 'jwt'
        ? [forced]
        : this.discoveredMode
          ? [this.discoveredMode, this.discoveredMode === 'token' ? 'jwt' : 'token']
          : ['token', 'jwt'];

    let lastError: unknown;

    for (const mode of order) {
      try {
        const token = await this.requestToken(mode);
        logger.info({ mode }, 'authenticated with BioTime');
        return { mode, token, obtainedAt: new Date() };
      } catch (err) {
        lastError = err;

        const status = (err as AxiosError)?.response?.status;

        // 404/405 means "wrong route for this build" — fall through and try the other scheme.
        if (status === 404 || status === 405) {
          logger.debug({ mode, status }, 'auth route not present on this BioTime build, trying the other');
          continue;
        }

        // 400/401 means the route exists and the credentials were rejected. Trying the other
        // scheme will not help, and repeatedly posting bad credentials can trip account lockout.
        if (status === 400 || status === 401 || status === 403) {
          throw new BiotimeAuthError(
            `BioTime rejected the credentials for ${requireBiotimeConfig().username} (HTTP ${status}). ` +
              `Check BIOTIME_USERNAME / BIOTIME_PASSWORD.`,
            status
          );
        }

        // Anything else (network, 5xx) — surface it; withRetry above decides.
        throw err;
      }
    }

    throw new BiotimeAuthError(
      `Could not authenticate with BioTime at ${requireBiotimeConfig().baseUrl}. Neither ` +
        `${ROUTES.token} nor ${ROUTES.jwt} accepted the login. Last error: ` +
        `${lastError instanceof Error ? lastError.message : String(lastError)}`
    );
  }

  private async requestToken(mode: AuthMode): Promise<string> {
    const url = ROUTES[mode];
    const { username, password } = requireBiotimeConfig();

    const response = await withRetry(
      () =>
        this.http.post(
          url,
          { username, password },
          {
            headers: { 'Content-Type': 'application/json' },
            // 404 is a legitimate probe outcome, not a transport failure — let it through so
            // doLogin can fall back instead of retrying it four times.
            validateStatus: (s) => (s >= 200 && s < 300) || s === 404 || s === 405,
          }
        ),
      {
        retries: env.BIOTIME_MAX_RETRIES,
        label: `biotime.auth:${mode}`,
        shouldRetry: (err) => isRetryable(err),
      }
    );

    if (response.status === 404 || response.status === 405) {
      throw Object.assign(new Error(`${url} not available (HTTP ${response.status})`), {
        response: { status: response.status },
      });
    }

    // Django builds (Easy Time Pro included) answer a missing API route by redirecting to the
    // HTML login page — axios follows it and hands back a 200 with a giant HTML string. Treat
    // that as "wrong route for this build" so doLogin still probes the other scheme, and never
    // stringify the body into the error (an HTML page's "keys" are its character indices).
    if (typeof response.data === 'string' || response.data === null) {
      throw Object.assign(
        new Error(
          `${url} answered with ${typeof response.data === 'string' ? 'an HTML page' : 'an empty body'}, ` +
            `not a token — this build does not serve that auth route (is BIOTIME_BASE_URL correct?)`
        ),
        { response: { status: 404 } }
      );
    }

    const body = response.data as Record<string, unknown> | undefined;
    const token =
      (typeof body?.token === 'string' && body.token) ||
      (typeof body?.access === 'string' && body.access) ||
      (typeof body?.access_token === 'string' && body.access_token) ||
      null;

    if (!token) {
      throw new BiotimeAuthError(
        `${url} returned HTTP ${response.status} without a token field. Body keys: ` +
          `${body ? Object.keys(body).slice(0, 10).join(', ') || '(empty)' : '(no body)'}`
      );
    }

    return token;
  }
}

/** Bare axios instance used only for the auth calls (no auth interceptor, so no recursion). */
export function createAuthHttp(): AxiosInstance {
  // allowAuth: the login POST is permitted here and nowhere else.
  return enforceReadOnly(
    axios.create({
      baseURL: currentBaseUrl(),
      timeout: env.BIOTIME_TIMEOUT_MS,
      headers: { Accept: 'application/json' },
    }),
    { allowAuth: true }
  );
}
