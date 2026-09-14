// Server-only gateway logic. Imported by api/v1/[resource].js and its contract tests, never UI.
export const DEVELOPER_API_MAX_OFFSET = 1000000;
export const DEVELOPER_API_TIMEOUT_MS = 8000;
const RESOURCES = new Set(['employees', 'organization', 'attendance']);
const CACHE_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
};
const ERRORS = {
  401: ['unauthorized', 'A valid API key is required.'],
  403: ['forbidden', 'This API key does not allow access to this resource.'],
  429: ['rate_limited', 'Too many requests. Try again in one minute.'],
  503: ['unavailable', 'The API is temporarily unavailable. Try again later.'],
};

function failure(status, message, code) {
  const defaults = ERRORS[status] ?? ['invalid_request', 'The request is invalid.'];
  const headers = { ...CACHE_HEADERS };
  if (status === 401) headers['WWW-Authenticate'] = 'Bearer realm="HR API"';
  if (status === 405) headers.Allow = 'GET';
  if (status === 429) headers['Retry-After'] = '60';
  return { status, headers, body: { error: { code: code ?? defaults[0], message: message ?? defaults[1] } } };
}

class InvalidRequest extends Error {
  constructor(status, message, code) { super(message); this.result = failure(status, message, code); }
}
const invalid = (message) => { throw new InvalidRequest(400, message); };

function header(request, name) {
  if (typeof request.headers?.get === 'function') return request.headers.get(name);
  const entries = Object.entries(request.headers ?? {}).filter(([key]) => key.toLowerCase() === name);
  return entries.length === 1 ? entries[0][1] : entries.length ? null : undefined;
}

function bearerKey(request) {
  const duplicateCount = (request.rawHeaders ?? []).filter((value, index) => index % 2 === 0 && String(value).toLowerCase() === 'authorization').length;
  const value = header(request, 'authorization');
  const match = typeof value === 'string' && value.length <= 300 && value.trim().match(/^Bearer[ \t]+([^\s,]+)$/i);
  if (duplicateCount > 1 || !match || !/^[\x21-\x7e]{1,256}$/.test(match[1])) throw new InvalidRequest(401);
  return match[1];
}

function integerParameter(parameters, name, fallback, minimum, maximum) {
  const raw = parameters.get(name);
  if (raw === null) return fallback;
  if (!/^\d{1,10}$/.test(raw)) invalid(`${name} must be a whole number between ${minimum} and ${maximum}.`);
  const value = Number(raw);
  if (value < minimum || value > maximum) invalid(`${name} must be a whole number between ${minimum} and ${maximum}.`);
  return value;
}

function dateParameter(parameters, name) {
  const value = parameters.get(name);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '') || value.startsWith('0000')) invalid('Attendance requires valid from and to dates in YYYY-MM-DD format.');
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== value) {
    invalid('Attendance requires valid from and to dates in YYYY-MM-DD format.');
  }
  return { value, milliseconds };
}

/** The original path stays authoritative regardless of how Vercel represents rewrite params. */
export function parseDeveloperApiRequest(request) {
  if (request.method !== 'GET') throw new InvalidRequest(405, 'Only GET requests are supported.', 'method_not_allowed');
  let url;
  try { url = new URL(request.url, 'https://gateway.invalid'); } catch { invalid('The request URL is invalid.'); }
  const parameters = url.searchParams;
  const routeResource = request.query?.resource;
  let resource = /^\/api\/v1\/([a-z-]+)\/?$/.exec(url.pathname)?.[1];
  const rewritten = /^\/api\/v1\/(?:\[resource\]|%5[bB]resource%5[dD])\/?$/.test(url.pathname);
  if (rewritten) {
    const resources = parameters.getAll('resource');
    if (resources.length > 1 || (routeResource !== undefined && typeof routeResource !== 'string')
        || (resources.length && routeResource !== undefined && resources[0] !== routeResource)) invalid('The resource route is invalid.');
    resource = routeResource ?? resources[0];
    parameters.delete('resource');
  } else {
    if (routeResource !== undefined && (typeof routeResource !== 'string' || routeResource !== resource)) {
      invalid('The resource route is invalid.');
    }
    // Some runtime paths retain the public pathname while adding the rewrite's resource query.
    // Accept only one selector that agrees with BOTH the pathname and Vercel's parsed query.
    if (parameters.has('resource')) {
      const selectors = parameters.getAll('resource');
      if (selectors.length !== 1 || selectors[0] !== resource || routeResource !== resource) invalid('The resource route is invalid.');
      parameters.delete('resource');
    }
  }
  if (!RESOURCES.has(resource)) throw new InvalidRequest(404, 'The requested API resource does not exist.', 'not_found');

  const allowed = new Set(resource === 'attendance' ? ['limit', 'offset', 'from', 'to'] : ['limit', 'offset']);
  for (const name of parameters.keys()) {
    if (/^(api_?key|key|access_token|token|authorization)$/i.test(name)) invalid('Supply API keys only in the Authorization header.');
    if (!allowed.has(name)) invalid('The request contains an unsupported query parameter.');
    if (parameters.getAll(name).length !== 1) invalid('Query parameters must not be repeated.');
  }

  // Vercel parses req.body lazily and may throw for malformed JSON. Every GET body is refused.
  try {
    const body = request.body;
    if (body != null && body !== '' && !(ArrayBuffer.isView(body) && body.byteLength === 0)) invalid('GET requests must not include a body.');
  } catch (error) {
    if (error instanceof InvalidRequest) throw error;
    invalid('GET requests must not include a body.');
  }
  const length = header(request, 'content-length');
  if ((length !== undefined && length !== null && length !== '0') || header(request, 'transfer-encoding')) invalid('GET requests must not include a body.');

  const key = bearerKey(request);
  const limit = integerParameter(parameters, 'limit', 50, 1, 100);
  const offset = integerParameter(parameters, 'offset', 0, 0, DEVELOPER_API_MAX_OFFSET);
  let from = null, to = null;
  if (resource === 'attendance') {
    const first = dateParameter(parameters, 'from'), last = dateParameter(parameters, 'to');
    if (last.milliseconds < first.milliseconds || last.milliseconds - first.milliseconds > 30 * 86400000) {
      invalid('Attendance dates must be ordered and span no more than 31 days, including both dates.');
    }
    from = first.value; to = last.value;
  }
  return { resource, limit, offset, key, from, to };
}

function publicProjectKey(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /\s/.test(value)) return null;
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(value)) return { key: value, jwt: false };
  // Refuse service-role/secret/session tokens even if accidentally put in the ANON variable.
  try {
    const parts = value.split('.');
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
    const claims = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return claims.role === 'anon' ? { key: value, jwt: true } : null;
  } catch { return null; }
}

export function developerApiEnvironment(environment = {}) {
  const address = environment.SUPABASE_URL || environment.VITE_SUPABASE_URL;
  const publicKey = publicProjectKey(environment.SUPABASE_ANON_KEY || environment.VITE_SUPABASE_ANON_KEY);
  try {
    const url = new URL(address);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!publicKey || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
        || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    return { endpoint: `${url.origin}/rest/v1/rpc/developer_api_read`, ...publicKey };
  } catch { return null; }
}

function upstreamFailure(status, payload) {
  const knownStatus = { PT400: 400, PT401: 401, PT403: 403, PT429: 429, PT503: 503 }[payload?.code];
  // HTTP-level 401/403 usually mean a deployment/configuration problem with the project's anon
  // key. Only the RPC's explicit codes attribute authentication/scope failures to the caller.
  return failure(knownStatus ?? (status === 429 ? 429 : 503));
}

function successPayload(payload, request) {
  if (!payload || typeof payload !== 'object' || !payload.pagination
      || payload.pagination.limit !== request.limit || payload.pagination.offset !== request.offset
      || typeof payload.pagination.has_more !== 'boolean') return null;
  const data = payload.data;
  if (!Array.isArray(data) || data.length > request.limit) return null;
  return { data, pagination: { limit: request.limit, offset: request.offset, has_more: payload.pagination.has_more } };
}

export async function handleDeveloperApiRequest(request, { environment = {}, fetchImpl = globalThis.fetch,
  timeoutMs = DEVELOPER_API_TIMEOUT_MS } = {}) {
  let parsed;
  try { parsed = parseDeveloperApiRequest(request); }
  catch (error) { return error instanceof InvalidRequest ? error.result : failure(400); }
  const config = developerApiEnvironment(environment);
  if (!config || typeof fetchImpl !== 'function') return failure(503);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { apikey: config.key, 'Content-Type': 'application/json', Accept: 'application/json' };
    if (config.jwt) headers.Authorization = `Bearer ${config.key}`;
    const response = await fetchImpl(config.endpoint, {
      method: 'POST', headers, redirect: 'error', cache: 'no-store', signal: controller.signal,
      body: JSON.stringify({ _api_key: parsed.key, _resource: parsed.resource, _limit: parsed.limit,
        _offset: parsed.offset, _from: parsed.from, _to: parsed.to }),
    });
    let payload;
    try { payload = await response.json(); } catch { return response.ok ? failure(503) : upstreamFailure(response.status, null); }
    if (!response.ok) return upstreamFailure(response.status, payload);
    const body = successPayload(payload, parsed);
    return body ? { status: 200, headers: { ...CACHE_HEADERS }, body } : failure(503);
  } catch { return failure(503); }
  finally { clearTimeout(timer); }
}
