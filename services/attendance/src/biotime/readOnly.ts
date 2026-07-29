// A hard stop on writing to Easy Time Pro.
//
// This service exists to READ an attendance system that HR depends on. It has no business creating,
// editing or deleting anything there — a stray write could alter an enrolment, a punch, or a shift
// that payroll is calculated from, in a system we do not own and cannot roll back.
//
// Today nothing writes: every data call is a GET, and the only POST is the login exchanging
// credentials for a token. This makes that a property of the code rather than a fact about its
// current state, so a future change that adds a write fails immediately and loudly instead of
// quietly modifying somebody's attendance record.
import type { AxiosInstance, InternalAxiosRequestConfig } from 'axios';

/** Login endpoints. A POST here returns a token; it stores nothing. */
const AUTH_PATHS = ['/api-token-auth/', '/jwt-api-token-auth/'];

export class BiotimeWriteBlocked extends Error {
  constructor(method: string, url: string) {
    super(
      `Refused to send ${method.toUpperCase()} ${url} to Easy Time Pro. This service is read-only ` +
        `by design — it must never create, change or delete anything in the attendance system it ` +
        `reads from. If a write is genuinely required, it has to be an explicit, reviewed decision, ` +
        `not something a helper function does on the way past.`
    );
    this.name = 'BiotimeWriteBlocked';
  }
}

const isAuthPath = (url: string): boolean =>
  AUTH_PATHS.some((p) => url === p || url.endsWith(p));

/** Attach to an axios instance so anything but a read is rejected before it leaves the process. */
export function enforceReadOnly(http: AxiosInstance, opts: { allowAuth?: boolean } = {}): AxiosInstance {
  http.interceptors.request.use((config: InternalAxiosRequestConfig) => {
    const method = (config.method ?? 'get').toLowerCase();
    const url = config.url ?? '';

    if (method === 'get' || method === 'head' || method === 'options') return config;
    if (opts.allowAuth && method === 'post' && isAuthPath(url)) return config;

    throw new BiotimeWriteBlocked(method, url);
  });
  return http;
}
