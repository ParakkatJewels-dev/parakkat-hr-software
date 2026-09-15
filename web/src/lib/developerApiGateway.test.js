import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import handler from '../../api/v1/[resource].js';
import { createDeveloperApiLimiter, developerApiEnvironment, handleDeveloperApiRequest } from './developerApiGateway.js';

const KEY = 'phr_synthetic_test_key_never_log';
const jwt = (role) => `e30.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.signature`;
const ENVIRONMENT = { SUPABASE_URL: 'https://project.example.com', SUPABASE_ANON_KEY: jwt('anon') };
const request = (resource = 'employees', query = '') => ({ method: 'GET', url: `/api/v1/${resource}${query}`,
  headers: { authorization: `Bearer ${KEY}` } });
const response = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
const success = (limit = 50, offset = 0, data = []) => ({ data, pagination: { limit, offset, has_more: false } });
async function invoke(req, { payload = success(), status = 200, environment = ENVIRONMENT, fetchImpl, ...rest } = {}) {
  const calls = [];
  const result = await handleDeveloperApiRequest(req, { environment,
    limiter: createDeveloperApiLimiter(),
    fetchImpl: fetchImpl ?? (async (...args) => { calls.push(args); return response(payload, status); }), ...rest });
  assert.match(result.headers['Cache-Control'], /no-store/);
  assert.equal(result.headers['CDN-Cache-Control'], 'no-store');
  assert.equal(result.headers['Vercel-CDN-Cache-Control'], 'no-store');
  assert.equal(result.headers['Access-Control-Allow-Origin'], undefined);
  return { result, calls };
}

test('valid GET forwards only validated arguments to the fixed RPC using the project anon key', async () => {
  const req = request('employees', '?limit=2&offset=5');
  req.headers.cookie = 'private-session-cookie';
  req.headers['x-api-key'] = 'untrusted-secondary-key';
  const { result, calls } = await invoke(req, { payload: { ...success(2, 5, [{ id: 'employee-one' }]), debug_secret: 'must-not-return' } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, success(2, 5, [{ id: 'employee-one' }]));
  assert.equal(calls.length, 1);
  const [url, options] = calls[0];
  assert.equal(url, 'https://project.example.com/rest/v1/rpc/developer_api_read');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.apikey, ENVIRONMENT.SUPABASE_ANON_KEY);
  assert.equal(options.headers.Authorization, `Bearer ${ENVIRONMENT.SUPABASE_ANON_KEY}`);
  assert.equal(options.headers.cookie, undefined);
  assert.equal(options.headers['x-api-key'], undefined);
  assert.equal(options.redirect, 'error');
  assert.equal(options.cache, 'no-store');
  assert.deepEqual(JSON.parse(options.body), { _api_key: KEY, _resource: 'employees', _limit: 2, _offset: 5, _from: null, _to: null });
  assert.equal(url.includes(KEY), false);
  assert.equal(JSON.stringify(options.headers).includes(KEY), false);
});

test('gateway rejects a repeated key before contacting PostgreSQL, then admits it after Retry-After', async () => {
  let clock = 1000;
  const limiter = createDeveloperApiLimiter({ now: () => clock, keyLimit: 2 });
  for (let i = 0; i < 2; i++) assert.equal((await invoke(request(), { limiter })).calls.length, 1);
  clock += 1500;
  const refused = await invoke(request(), { limiter });
  assert.equal(refused.result.status, 429);
  assert.equal(refused.calls.length, 0);
  assert.equal(refused.result.headers['Retry-After'], '59');
  assert.equal(JSON.stringify(refused.result).includes(KEY), false);
  clock += 58500;
  assert.equal((await invoke(request(), { limiter })).result.status, 200);
});

test('gateway bounds rotating keys and simultaneous upstream work without caching authorized responses', async () => {
  const limiter = createDeveloperApiLimiter({ processLimit: 2, maximumConcurrent: 1 });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const first = invoke(request(), { limiter, fetchImpl: async () => { await held; return response(success()); } });
  const busy = await invoke(request(), { limiter });
  assert.equal(busy.result.status, 429);
  assert.equal(busy.calls.length, 0);
  assert.equal(busy.result.headers['Retry-After'], '5');
  release();
  assert.equal((await first).result.status, 200);
  const other = request(); other.headers.authorization = 'Bearer different-synthetic-key';
  assert.equal((await invoke(other, { limiter })).calls.length, 1, 'a fresh authorization and data read is still required');
  other.headers.authorization = 'Bearer third-synthetic-key';
  assert.equal((await invoke(other, { limiter })).result.status, 429, 'rotating keys cannot bypass the process budget');
  const bounded = createDeveloperApiLimiter({ maximumKeys: 1 });
  assert.equal((await invoke(request(), { limiter: bounded })).result.status, 200);
  assert.equal((await invoke(other, { limiter: bounded })).calls.length, 0, 'active identities are never evicted to admit an unbounded stream');
});

test('gateway releases concurrency capacity when an upstream request fails', async () => {
  const limiter = createDeveloperApiLimiter({ maximumConcurrent: 1 });
  assert.equal((await invoke(request(), { limiter, fetchImpl: async () => { throw new Error('fixture'); } })).result.status, 503);
  assert.equal((await invoke(request(), { limiter })).result.status, 200);
});

test('default and boundary pagination work for employees and flat organization rows', async () => {
  for (const [resource, query, limit, offset] of [
    ['employees', '', 50, 0], ['organization', '?limit=100&offset=1000000', 100, 1000000],
  ]) {
    const { result, calls } = await invoke(request(resource, query), { payload: success(limit, offset) });
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(calls[0][1].body)._resource, resource);
    assert.deepEqual(result.body.pagination, { limit, offset, has_more: false });
  }
});

test('Bearer auth is required, bounded, singular and never accepted from cookies or other headers', async () => {
  for (const authorization of [undefined, '', 'Basic value', 'Bearer ', 'Bearer one two', 'Bearer one,two',
    `Bearer ${'x'.repeat(257)}`, 'Bearer key\nInjected:value', ['Bearer first', 'Bearer second']]) {
    const req = request(); req.headers = { authorization, cookie: `api_key=${KEY}`, 'x-api-key': KEY };
    const { result, calls } = await invoke(req);
    assert.equal(result.status, 401); assert.equal(calls.length, 0);
    assert.equal(result.headers['WWW-Authenticate'], 'Bearer realm="HR API"');
  }
  const duplicate = request(); duplicate.rawHeaders = ['Authorization', `Bearer ${KEY}`, 'authorization', 'Bearer second'];
  assert.equal((await invoke(duplicate)).result.status, 401);
  const valid = request(); valid.headers.authorization = `bearer ${'x'.repeat(256)}`;
  assert.equal((await invoke(valid)).result.status, 200);
});

test('query-string secrets, unexpected parameters and duplicate parameters are refused before forwarding', async () => {
  for (const query of ['?api_key=secret', '?apikey=secret', '?API_KEY=secret', '?key=secret', '?access_token=secret',
    '?token=secret', '?authorization=secret', '?limit=1&limit=2', '?offset=0&offset=1', '?sort=name', '?from=2026-01-01', '?resource=attendance']) {
    for (const resource of ['employees', 'organization']) {
      const { result, calls } = await invoke(request(resource, query));
      assert.equal(result.status, 400); assert.equal(calls.length, 0);
      assert.equal(JSON.stringify(result.body).includes('secret'), false);
    }
  }
});

test('malformed or out-of-range pagination never reaches the database', async () => {
  for (const query of ['?limit=0', '?limit=101', '?limit=-1', '?limit=1.5', '?limit=', '?limit=1e2', '?limit=%20',
    '?offset=-1', '?offset=1000001', '?offset=NaN', '?offset=Infinity', '?offset=9007199254740992', '?offset=+1']) {
    const { result, calls } = await invoke(request('employees', query));
    assert.equal(result.status, 400); assert.equal(calls.length, 0);
  }
});

test('attendance accepts valid inclusive ranges up to 31 days and forwards ISO dates unchanged', async () => {
  for (const query of ['?from=2026-01-01&to=2026-01-31', '?from=2024-02-29&to=2024-02-29', '?from=2026-12-20&to=2027-01-19']) {
    const { result, calls } = await invoke(request('attendance', query));
    assert.equal(result.status, 200);
    const params = new URLSearchParams(query), body = JSON.parse(calls[0][1].body);
    assert.equal(body._from, params.get('from')); assert.equal(body._to, params.get('to'));
  }
});

test('attendance requires real ISO dates, ascending range and no extra or duplicate fields', async () => {
  for (const query of ['', '?from=2026-01-01', '?to=2026-01-01', '?from=2026-01-01&to=2026-02-01',
    '?from=2026-01-02&to=2026-01-01', '?from=2026-02-29&to=2026-03-01', '?from=2026-02-30&to=2026-03-01',
    '?from=2026-1-1&to=2026-01-01', '?from=0000-01-01&to=0000-01-01',
    '?from=2026-01-01T00:00:00Z&to=2026-01-01', '?from=2026-01-01&to=2026-01-01&employee_id=other',
    '?from=2026-01-01&from=2026-01-02&to=2026-01-01']) {
    const { result, calls } = await invoke(request('attendance', query));
    assert.equal(result.status, 400); assert.equal(calls.length, 0);
  }
});

test('only the three resources and GET are supported; request bodies are never consumed as arguments', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
    const { result, calls } = await invoke({ ...request(), method });
    assert.equal(result.status, 405); assert.equal(result.headers.Allow, 'GET'); assert.equal(calls.length, 0);
  }
  for (const resource of ['payroll', 'developer_api_read', '../employees', 'employees/other']) {
    const { result, calls } = await invoke(request(resource));
    assert.equal(result.status, 404); assert.equal(calls.length, 0);
  }
  const bodies = [{}, [], { _api_key: KEY }, 'payload'];
  for (const body of bodies) assert.equal((await invoke({ ...request(), body })).result.status, 400);
  for (const headers of [{ 'content-length': '1' }, { 'transfer-encoding': 'chunked' }]) {
    const req = request(); Object.assign(req.headers, headers);
    assert.equal((await invoke(req)).result.status, 400);
  }
  const malformedBody = request(); Object.defineProperty(malformedBody, 'body', { get() { throw new Error(`Malformed JSON contains ${KEY}`); } });
  assert.equal((await invoke(malformedBody)).result.status, 400);
});

test('Vercel rewritten paths work while a conflicting query resource cannot override the original path', async () => {
  const rewritten = { ...request(), url: '/api/v1/[resource]?resource=employees&limit=1', query: { resource: 'employees' } };
  assert.equal((await invoke(rewritten, { payload: success(1) })).result.status, 200);
  const original = { ...request(), query: { resource: 'employees' } };
  assert.equal((await invoke(original)).result.status, 200);
  const preserved = { ...request('employees', '?resource=employees&limit=1'), query: { resource: 'employees', limit: '1' } };
  const preservedResult = await invoke(preserved, { payload: success(1) });
  assert.equal(preservedResult.result.status, 200);
  assert.equal(JSON.parse(preservedResult.calls[0][1].body)._resource, 'employees');
  for (const req of [
    { ...request(), query: { resource: 'attendance' } },
    { ...preserved, url: '/api/v1/employees?resource=attendance&limit=1' },
    { ...preserved, url: '/api/v1/employees?resource=employees&resource=employees&limit=1' },
    { ...preserved, query: { resource: 'attendance', limit: '1' } },
    { ...rewritten, query: { resource: 'attendance' } },
    { ...rewritten, query: { resource: ['employees', 'attendance'] } },
    { ...rewritten, url: '/api/v1/[resource]?resource=employees&resource=attendance' },
  ]) assert.equal((await invoke(req)).result.status, 400);
});

test('runtime configuration accepts public keys and VITE fallbacks but fails closed for secrets and unsafe URLs', async () => {
  const fallback = { VITE_SUPABASE_URL: 'https://fallback.example.com/', VITE_SUPABASE_ANON_KEY: 'sb_publishable_synthetic' };
  assert.equal(developerApiEnvironment(fallback).endpoint, 'https://fallback.example.com/rest/v1/rpc/developer_api_read');
  const { calls, result } = await invoke(request(), { environment: fallback });
  assert.equal(result.status, 200); assert.equal(calls[0][1].headers.apikey, 'sb_publishable_synthetic');
  assert.equal(calls[0][1].headers.Authorization, undefined);
  assert.ok(developerApiEnvironment({ ...ENVIRONMENT, SUPABASE_URL: 'http://127.0.0.1:54321' }));
  for (const environment of [{}, { SUPABASE_URL: ENVIRONMENT.SUPABASE_URL },
    { ...ENVIRONMENT, SUPABASE_ANON_KEY: 'sb_secret_private' }, { ...ENVIRONMENT, SUPABASE_ANON_KEY: jwt('service_role') },
    { ...ENVIRONMENT, SUPABASE_ANON_KEY: jwt('authenticated') }, { ...ENVIRONMENT, SUPABASE_ANON_KEY: 'malformed' },
    ...['http://remote.example.com', 'ftp://project.example.com', 'https://user:password@project.example.com',
      'https://project.example.com/other', 'https://project.example.com?secret=value', 'https://project.example.com#secret'].map((SUPABASE_URL) => ({ ...ENVIRONMENT, SUPABASE_URL })),
  ]) {
    const failed = await invoke(request(), { environment });
    assert.equal(failed.result.status, 503); assert.equal(failed.calls.length, 0);
  }
});

test('backend errors are mapped only from known codes and never echo details, secrets or HTML', async () => {
  for (const [code, status] of [['PT400', 400], ['PT401', 401], ['PT403', 403], ['PT429', 429], ['PT503', 503], ['PGRST202', 503], ['42501', 503]]) {
    const { result } = await invoke(request(), { status: 400, payload: { code, message: KEY, details: `SQL leaked ${KEY}`, hint: 'service_role credential' } });
    assert.equal(result.status, status);
    assert.equal(JSON.stringify(result).includes(KEY), false);
    assert.equal(JSON.stringify(result).includes('service_role'), false);
    if (status === 429) assert.equal(result.headers['Retry-After'], '60');
  }
  const deniedProject = await invoke(request(), { status: 401, payload: { message: 'Invalid project JWT' } });
  assert.equal(deniedProject.result.status, 503);
  const quota = await invoke(request(), { fetchImpl: async () => new Response(`<html>${KEY}</html>`, { status: 429 }) });
  assert.equal(quota.result.status, 429); assert.equal(JSON.stringify(quota.result).includes(KEY), false);
});

test('network failures, redirects, invalid JSON and malformed success payloads return sanitized 503', async () => {
  for (const fetchImpl of [
    async () => { throw new Error(`network error ${KEY}`); },
    async () => new Response(`<html>${KEY}</html>`, { status: 502 }),
    async () => new Response('', { status: 302, headers: { Location: `https://other.example.com/${KEY}` } }),
    async () => response(null), async () => response({ data: [], pagination: { limit: 100, offset: 0, has_more: false } }),
    async () => response({ ...success(), data: 'private-text' }), async () => response({ ...success(), data: Array(51).fill({}) }),
  ]) {
    const { result } = await invoke(request(), { fetchImpl });
    assert.equal(result.status, 503); assert.equal(JSON.stringify(result).includes(KEY), false);
  }
  assert.equal((await invoke(request('organization'), { payload: success(50, 0, { entities: [] }) })).result.status, 503);
});

test('upstream timeout aborts the request and returns a safe unavailable response', async () => {
  let aborted = false;
  const { result } = await invoke(request(), { timeoutMs: 5, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error(`Timeout ${KEY}`)); }, { once: true });
  }) });
  assert.equal(aborted, true); assert.equal(result.status, 503);
  assert.equal(JSON.stringify(result).includes(KEY), false);
});

test('the actual Node handler sends no-store JSON and the Vercel config routes its dynamic endpoint', async () => {
  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const result = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/employees`, { method: 'OPTIONS' });
    assert.equal(result.status, 405); assert.equal(result.headers.get('allow'), 'GET');
    assert.match(result.headers.get('cache-control'), /no-store/);
    assert.equal((await result.json()).error.code, 'method_not_allowed');
  } finally { await new Promise((resolve) => server.close(resolve)); }
  const config = JSON.parse(await readFile(new URL('../../vercel.json', import.meta.url), 'utf8'));
  assert.ok(config.rewrites.some((rule) => rule.source === '/api/v1/:resource' && rule.destination === '/api/v1/[resource]?resource=:resource'));
});
