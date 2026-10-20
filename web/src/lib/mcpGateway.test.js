import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { once } from 'node:events';
import handler from '../../api/mcp.js';
import { createDeveloperApiLimiter, developerApiEnvironment } from './developerApiGateway.js';
import { MCP_MAX_BODY_BYTES, handleMcpRequest } from './mcpGateway.js';

const KEY = 'phr_synthetic_test_key_never_log';
const jwt = (role) => `e30.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.signature`;
const ENVIRONMENT = { SUPABASE_URL: 'https://project.example.com', SUPABASE_ANON_KEY: jwt('anon') };
const ME = { user_id: 'u1', employee: { id: 'e1', name: 'Asha Menon' }, areas: ['tasks:manage', 'goals:manage'] };
const response = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
const request = (message, headers = {}) => ({ method: 'POST', url: '/api/mcp', body: message,
  headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } });
const call = (name, args, id = 3) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

/** Default upstream: whoami answers ME, any other tool echoes its arguments. */
async function invoke(req, { upstream, environment = ENVIRONMENT, ...rest } = {}) {
  const calls = [];
  const result = await handleMcpRequest(req, { environment, limiter: createDeveloperApiLimiter(), ...rest,
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      const body = JSON.parse(options.body);
      if (upstream) return upstream(body);
      return response({ ok: true, data: body._tool === 'whoami' ? ME : { echoed: body._args } });
    } });
  assert.match(result.headers['Cache-Control'], /no-store/);
  assert.equal(result.headers['Access-Control-Allow-Origin'], undefined);
  assert.equal(JSON.stringify(result).includes(KEY), false, 'the key never comes back');
  return { result, calls };
}

test('initialize checks the key, negotiates the protocol and names who the assistant acts as', async () => {
  const { result, calls } = await invoke(request({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hermes', version: '1' } } }));
  assert.equal(result.status, 200);
  assert.equal(result.body.id, 1);
  assert.equal(result.body.result.protocolVersion, '2025-06-18');
  assert.deepEqual(result.body.result.capabilities, { tools: { listChanged: false } });
  assert.equal(result.body.result.serverInfo.name, 'parakkat-hr');
  assert.match(result.body.result.instructions, /Asha Menon/);
  assert.match(result.body.result.instructions, /Nothing can be deleted/);
  assert.equal(calls.length, 1);
  const [url, options] = calls[0];
  assert.equal(url, 'https://project.example.com/rest/v1/rpc/developer_api_call');
  assert.equal(options.headers.apikey, ENVIRONMENT.SUPABASE_ANON_KEY);
  assert.equal(options.redirect, 'error');
  assert.deepEqual(JSON.parse(options.body), { _api_key: KEY, _tool: 'whoami', _args: {} });
  assert.equal(url.includes(KEY), false);
  assert.equal(JSON.stringify(options.headers).includes(KEY), false);

  const unknown = await invoke(request({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }));
  assert.equal(unknown.result.body.result.protocolVersion, '2025-11-25');
});

test('tools/list shows only the basics and the key\'s own areas, with no delete tool', async () => {
  const { result } = await invoke(request({ jsonrpc: '2.0', id: 'list', method: 'tools/list' }));
  const names = result.body.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('whoami') && names.includes('create_task') && names.includes('update_goal'));
  assert.ok(!names.includes('decide_leave') && !names.includes('assign_asset'), 'areas not on the key are hidden');
  assert.ok(names.every((name) => !/delete|remove|trash/.test(name)));
  for (const tool of result.body.result.tools) {
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
});

test('tools/call forwards checked arguments and returns text plus structured content', async () => {
  const args = { title: 'Count trays', assignee_id: '1b4e28ba-2fa1-11d2-883f-0016d3cca427', priority: 'high' };
  const { result, calls } = await invoke(request(call('create_task', args)));
  assert.equal(result.status, 200);
  assert.equal(result.body.result.isError, false);
  assert.deepEqual(result.body.result.structuredContent, { echoed: args });
  assert.deepEqual(JSON.parse(result.body.result.content[0].text), { echoed: args });
  assert.deepEqual(JSON.parse(calls[0][1].body), { _api_key: KEY, _tool: 'create_task', _args: args });
});

test('badly shaped arguments come back as a tool error the assistant can fix, without a database call', async () => {
  for (const [name, args, pattern] of [
    ['create_task', { title: 'x' }, /assignee_id is required/],
    ['create_task', { title: 'x', assignee_id: 'a', owner: 'b' }, /owner is not a known field/],
    ['list_tasks', { limit: 'ten' }, /whole number/],
    ['list_tasks', { limit: 500 }, /from 1 to 50/],
    ['create_task', { title: 'x'.repeat(201), assignee_id: 'a' }, /at most 200/],
    ['add_task_helpers', { task_id: 't', employee_ids: [] }, /at least 1/],
    ['create_task', 'not an object', /must be an object/],
  ]) {
    const { result, calls } = await invoke(request(call(name, args)));
    assert.equal(result.body.result.isError, true);
    assert.match(result.body.result.content[0].text, pattern);
    assert.equal(calls.length, 0);
  }
});

test('database refusals become tool errors; unknown tools and methods are JSON-RPC errors', async () => {
  const refused = await invoke(request(call('list_tasks', {})), {
    upstream: () => response({ ok: false, error: { code: 'forbidden', message: 'Your role does not allow this action.' } }) });
  assert.equal(refused.result.status, 200);
  assert.equal(refused.result.body.result.isError, true);
  assert.equal(refused.result.body.result.content[0].text, 'Your role does not allow this action.');

  const area = await invoke(request(call('list_tasks', {})), { upstream: () => response({ code: 'PT403', message: 'x' }, 403) });
  assert.match(area.result.body.result.content[0].text, /does not include that area/);

  const unknownTool = await invoke(request(call('drop_everything', {})));
  assert.equal(unknownTool.result.body.error.code, -32602);
  assert.equal(unknownTool.calls.length, 0);

  const unknownMethod = await invoke(request({ jsonrpc: '2.0', id: 9, method: 'resources/list' }));
  assert.equal(unknownMethod.result.body.error.code, -32601);
  assert.equal(unknownMethod.calls.length, 0);
});

test('a bad, revoked or disabled key is an HTTP error; rate limits stay readable to the assistant', async () => {
  const bad = await invoke(request({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), { upstream: () => response({ code: 'PT401', message: 'x' }, 401) });
  assert.equal(bad.result.status, 401);
  assert.match(bad.result.headers['WWW-Authenticate'], /^Bearer/);
  const off = await invoke(request(call('list_tasks', {})), { upstream: () => response({ code: 'PT503', message: 'x' }, 503) });
  assert.equal(off.result.status, 503);
  const busy = await invoke(request(call('list_tasks', {})), { upstream: () => response({ code: 'PT429', message: 'x' }, 429) });
  assert.equal(busy.result.status, 200);
  assert.equal(busy.result.body.result.isError, true);
  assert.match(busy.result.body.result.content[0].text, /Too many requests/);

  let clock = 0;
  const limiter = createDeveloperApiLimiter({ now: () => clock, keyLimit: 1 });
  assert.equal((await invoke(request(call('list_tasks', {})), { limiter })).result.body.result.isError, false);
  const limited = await invoke(request(call('list_tasks', {})), { limiter });
  assert.equal(limited.calls.length, 0);
  assert.equal(limited.result.body.result.isError, true);
  const listLimited = await invoke(request({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), { limiter });
  assert.equal(listLimited.result.status, 429);
  assert.ok(Number(listLimited.result.headers['Retry-After']) > 0);
});

test('upstream details, HTML and unexpected payloads never reach the assistant', async () => {
  for (const upstream of [
    () => response({ code: '42501', message: `SQL leaked ${KEY}`, details: 'relation hr_agent' }, 400),
    () => new Response('<html>gateway</html>', { status: 502 }),
    () => response({ data: [] }),
    () => { throw new Error(`network ${KEY}`); },
  ]) {
    const { result } = await invoke(request(call('list_tasks', {})), { upstream });
    assert.equal(result.status, 503);
    assert.doesNotMatch(JSON.stringify(result.body), /SQL|relation|html|network/i);
  }
});

test('only POSTed single JSON-RPC messages with a bearer key are accepted', async () => {
  assert.equal((await invoke({ ...request({}), method: 'GET' })).result.status, 405);
  assert.equal((await invoke({ ...request({}), method: 'GET' })).result.headers.Allow, 'POST');
  assert.equal((await invoke({ ...request({}), method: 'DELETE' })).result.status, 405);
  assert.equal((await invoke(request({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' }))).result.status, 403);
  assert.equal((await invoke(request({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'content-type': 'text/plain' }))).result.status, 415);
  assert.equal((await invoke(request({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'mcp-protocol-version': '1999-01-01' }))).result.status, 400);
  assert.equal((await invoke(request([{ jsonrpc: '2.0', id: 1, method: 'ping' }]))).result.status, 400);
  assert.equal((await invoke(request({ id: 1, method: 'ping' }))).result.status, 400);
  assert.equal((await invoke(request({ jsonrpc: '2.0', id: null, method: 'ping' }))).result.status, 400);
  assert.equal((await invoke(request('{not json'))).result.body.error.code, -32700);
  assert.equal((await invoke(request({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(MCP_MAX_BODY_BYTES) } }))).result.status, 413);
  assert.equal((await invoke(request({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'content-length': String(MCP_MAX_BODY_BYTES + 1) }))).result.status, 413);
  for (const authorization of [undefined, '', 'Basic abc', `Bearer ${KEY} extra`]) {
    const { result, calls } = await invoke(request({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization }));
    assert.equal(result.status, 401);
    assert.equal(calls.length, 0);
  }
  const ping = await invoke(request({ jsonrpc: '2.0', id: 7, method: 'ping' }, { 'mcp-protocol-version': '2025-06-18' }));
  assert.deepEqual(ping.result.body, { jsonrpc: '2.0', id: 7, result: {} });
  assert.equal(ping.calls.length, 0);
  const note = await invoke(request({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.equal(note.result.status, 202);
  assert.equal(note.result.body, null);
  assert.equal(note.calls.length, 0);
});

test('the assistant endpoint uses only the fixed entry point and fails closed without a public project key', async () => {
  assert.equal(developerApiEnvironment(ENVIRONMENT, 'developer_api_call').endpoint, 'https://project.example.com/rest/v1/rpc/developer_api_call');
  assert.equal(developerApiEnvironment(ENVIRONMENT, 'decide_leave'), null);
  for (const environment of [{}, { ...ENVIRONMENT, SUPABASE_ANON_KEY: jwt('service_role') }]) {
    const { result, calls } = await invoke(request({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), { environment });
    assert.equal(result.status, 503);
    assert.equal(calls.length, 0);
  }
});

test('the actual Node handler answers JSON-RPC over HTTP and sends an empty 202 for notifications', async () => {
  const previous = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_ANON_KEY };
  delete process.env.SUPABASE_URL; delete process.env.SUPABASE_ANON_KEY;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => { req.body = raw; handler(req, res); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/mcp`;
    const headers = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
    const ping = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    assert.equal(ping.status, 200);
    assert.match(ping.headers.get('cache-control'), /no-store/);
    assert.deepEqual(await ping.json(), { jsonrpc: '2.0', id: 1, result: {} });
    const note = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    assert.equal(note.status, 202);
    assert.equal(await note.text(), '');
    const list = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    assert.equal(list.status, 503, 'no project configuration means unavailable, never a guess');
  } finally {
    server.close();
    if (previous.url !== undefined) process.env.SUPABASE_URL = previous.url;
    if (previous.key !== undefined) process.env.SUPABASE_ANON_KEY = previous.key;
  }
});

test('a ledger report comes back with its WhatsApp-ready share text', async () => {
  const report = { period: 'day', from: '2026-10-07', to: '2026-10-07', single_day: true,
    worked_on: [{ title: 'Diwali hoarding v2', brand_label: 'Jewels', event: 'Sent for internal review', notes: [] }] };
  const { result } = await invoke(request(call('ledger_report', { period: 'day' })), {
    upstream: (body) => response({ ok: true, data: body._tool === 'whoami' ? ME : report }) });
  assert.match(result.body.result.structuredContent.share_text, /^\*Parakkat Work — Daily Report\*\n7 October 2026\n\n\*Worked on:\*\n• Diwali hoarding v2 \(Jewels\) → Sent for internal review/);
});

test('a reminder set through the assistant is mirrored to Google Calendar when connected', async () => {
  const { randomBytes } = await import('node:crypto');
  const { seal } = await import('./googleOAuth.js');
  const key = randomBytes(32);
  const owner = '60000000-0000-0000-0000-000000000001';
  const environment = { ...ENVIRONMENT, GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_TOKEN_KEY: key.toString('base64'),
    GOOGLE_REDIRECT_URI: 'https://hr.example.com/api/google/callback' };
  const tools = [];
  let acked;
  const fetchImpl = async (url, options) => {
    if (url.includes('oauth2.googleapis.com/token')) return response({ access_token: 'access' });
    if (url.includes('googleapis.com/calendar')) return response({ id: JSON.parse(options.body).id });
    const body = JSON.parse(options.body);
    tools.push(body._tool);
    if (body._tool === 'ledger_add_reminder') return response({ ok: true, data: { reminder: { id: 'r1', text: 'Call printer' }, calendar: true } });
    if (body._tool === 'ledger_google_secret') return response({ ok: true, data: { owner, ciphertext: seal(key, 'refresh', owner), status: 'connected' } });
    if (body._tool === 'ledger_calendar_outbox') return response({ ok: true, data: { items: [{ id: '11111111-1111-1111-1111-111111111111', op: 'insert', text: 'Call printer', due_at: '2026-10-08T10:00' }] } });
    if (body._tool === 'ledger_calendar_ack') { acked = body._args.results; return response({ ok: true, data: { acknowledged: 1 } }); }
    return response({ ok: true, data: ME });
  };
  const result = await handleMcpRequest(request(call('ledger_add_reminder', { text: 'Call printer', due_at: '2026-10-08T10:00' })),
    { environment, fetchImpl, limiter: createDeveloperApiLimiter() });
  assert.equal(result.body.result.structuredContent.calendar_sync, 'synced');
  assert.deepEqual(tools, ['ledger_add_reminder', 'ledger_google_secret', 'ledger_calendar_outbox', 'ledger_calendar_ack']);
  assert.equal(acked[0].ok, true);
  assert.ok(!JSON.stringify(result.body).includes('refresh'), 'the token never reaches the assistant');
  const unconfigured = await handleMcpRequest(request(call('ledger_add_reminder', { text: 'x', due_at: '2026-10-08T10:00' })),
    { environment: ENVIRONMENT, fetchImpl, limiter: createDeveloperApiLimiter() });
  assert.equal(unconfigured.body.result.structuredContent.calendar_sync, 'pending', 'without server keys it syncs when the owner next opens the ledger');
});
