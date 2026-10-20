// Server-only MCP endpoint for AI assistants such as Hermes. Imported by api/mcp.js and its contract
// tests, never by the UI. Stateless Streamable HTTP: every POST carries one JSON-RPC message and gets
// one JSON reply; there is no session and no server-sent stream. The database validates the key and
// every tool argument again (it is reachable directly through anonymous PostgREST), so the checks
// here only give the assistant faster, clearer answers.
import { Buffer } from 'node:buffer';
import {
  DEVELOPER_API_TIMEOUT_MS, bearerKey, createDeveloperApiLimiter, developerApiEnvironment, header,
} from './developerApiGateway.js';
import { HERMES_TOOL_MAP, checkArguments, mcpTool, toolsForAreas } from './hermesTools.js';

export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const MCP_MAX_BODY_BYTES = 64 * 1024;
const SERVER_INFO = { name: 'parakkat-hr', title: 'Parakkat HR', version: '1.0.0' };
const requestLimiter = createDeveloperApiLimiter();
const HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
};
const HTTP_ERRORS = {
  400: 'The request is not a valid MCP message.',
  401: 'A valid personal API key is required.',
  403: 'Browser requests are not accepted.',
  405: 'Use POST with one JSON-RPC message.',
  413: 'The request is too large.',
  415: 'Send JSON (Content-Type: application/json).',
  429: 'Too many requests. Try again in one minute.',
  503: 'The HR assistant service is unavailable or turned off.',
};

const reply = (id, result) => ({ status: 200, headers: { ...HEADERS }, body: { jsonrpc: '2.0', id, result } });
const rpcError = (id, code, message, status = 200) => ({ status, headers: { ...HEADERS }, body: { jsonrpc: '2.0', id, error: { code, message } } });
const accepted = () => ({ status: 202, headers: { ...HEADERS }, body: null });

function httpFailure(status, message = HTTP_ERRORS[status], { id = null, retryAfter } = {}) {
  const result = rpcError(id, status === 400 ? -32600 : -32000 - status, message, status);
  if (status === 401) result.headers['WWW-Authenticate'] = 'Bearer realm="Parakkat HR"';
  if (status === 405) result.headers.Allow = 'POST';
  if (status === 429) result.headers['Retry-After'] = String(retryAfter ?? 60);
  return result;
}

const toolText = (data) => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
  ...(data && typeof data === 'object' && !Array.isArray(data) ? { structuredContent: data } : {}),
  isError: false,
});
const toolError = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

function readBody(request) {
  const length = header(request, 'content-length');
  if (length && Number(length) > MCP_MAX_BODY_BYTES) return { failure: httpFailure(413) };
  let body;
  // Vercel parses req.body lazily and throws for malformed JSON.
  try { body = request.body; } catch { return { failure: rpcError(null, -32700, 'The body is not valid JSON.', 400) }; }
  if (typeof body === 'string' || ArrayBuffer.isView(body)) {
    const raw = typeof body === 'string' ? body : Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');
    if (Buffer.byteLength(raw) > MCP_MAX_BODY_BYTES) return { failure: httpFailure(413) };
    try { body = JSON.parse(raw); } catch { return { failure: rpcError(null, -32700, 'The body is not valid JSON.', 400) }; }
  } else if (body !== undefined && Buffer.byteLength(JSON.stringify(body) ?? '') > MCP_MAX_BODY_BYTES) {
    return { failure: httpFailure(413) };
  }
  return { body };
}

/** One database round trip: run a tool as the key's owner. */
async function callDatabase(context, key, tool, args) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), context.timeoutMs);
  try {
    const headers = { apikey: context.config.key, 'Content-Type': 'application/json', Accept: 'application/json' };
    if (context.config.jwt) headers.Authorization = `Bearer ${context.config.key}`;
    const response = await context.fetchImpl(context.config.endpoint, {
      method: 'POST', headers, redirect: 'error', cache: 'no-store', signal: controller.signal,
      body: JSON.stringify({ _api_key: key, _tool: tool, _args: args }),
    });
    let payload = null;
    try { payload = await response.json(); } catch { /* handled below */ }
    if (response.ok) {
      if (payload?.ok === true) return { ok: true, data: payload.data ?? null };
      if (payload?.ok === false && typeof payload.error?.message === 'string') return { toolError: payload.error.message };
      return { status: 503 };
    }
    // Only the entry point's explicit codes are attributed to the caller; anything else is ours.
    switch (payload?.code) {
      case 'PT401': return { status: 401 };
      case 'PT403': return { toolError: 'This key does not include that area. Create a key with that area in HR Settings → AI assistant.' };
      case 'PT400': return { toolError: typeof payload.message === 'string' ? payload.message : 'The request was refused.' };
      case 'PT429': return { status: 429 };
      default: return { status: response.status === 429 ? 429 : 503 };
    }
  } catch { return { status: 503 }; }
  finally { clearTimeout(timer); }
}

function instructions(me) {
  const name = me?.employee?.name ? `${me.employee.name}` : 'the key owner';
  return `You act in Parakkat HR as ${name}. Everything you do is recorded under their name and limited to what their role allows. `
    + 'Nothing can be deleted: close work by changing its status (for example a task to Cancelled, a goal to Dropped). '
    + 'Look up ids with find_employees, list_departments and the list_* tools before creating or changing records. Dates are YYYY-MM-DD.';
}

export async function handleMcpRequest(request, { environment = {}, fetchImpl = globalThis.fetch,
  timeoutMs = DEVELOPER_API_TIMEOUT_MS, limiter = requestLimiter } = {}) {
  if (request.method !== 'POST') return httpFailure(405);
  // MCP servers must refuse browser origins (DNS rebinding); assistants call from servers.
  if (header(request, 'origin')) return httpFailure(403);
  const type = header(request, 'content-type');
  if (typeof type !== 'string' || !/^application\/json\b/i.test(type.trim())) return httpFailure(415);
  const version = header(request, 'mcp-protocol-version');
  if (version !== undefined && version !== null && !MCP_PROTOCOL_VERSIONS.includes(version)) {
    return httpFailure(400, 'Unsupported MCP-Protocol-Version.');
  }
  const { body: message, failure } = readBody(request);
  if (failure) return failure;
  if (Array.isArray(message)) return httpFailure(400, 'Batch requests are not supported.');
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') return httpFailure(400);
  const isRequest = typeof message.method === 'string' && Object.hasOwn(message, 'id');
  const id = isRequest ? message.id : null;
  if (isRequest && (typeof id !== 'string' && !Number.isInteger(id))) return httpFailure(400, 'A request id must be a string or integer.');

  let key;
  try { key = bearerKey(request); } catch { return httpFailure(401); }
  // Notifications and client responses need no answer.
  if (!isRequest) return typeof message.method === 'string' || 'result' in message || 'error' in message ? accepted() : httpFailure(400);
  if (message.method === 'ping') return reply(id, {});

  const config = developerApiEnvironment(environment, 'developer_api_call');
  if (!config || typeof fetchImpl !== 'function') return httpFailure(503, undefined, { id });
  const admission = limiter.enter(key);
  if (admission.retryAfter) {
    return message.method === 'tools/call'
      ? reply(id, toolError(`Too many requests. Try again in ${admission.retryAfter} seconds.`))
      : httpFailure(429, undefined, { id, retryAfter: admission.retryAfter });
  }
  const context = { config, fetchImpl, timeoutMs };
  try {
    const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params) ? message.params : {};
    switch (message.method) {
      case 'initialize':
      case 'tools/list': {
        const me = await callDatabase(context, key, 'whoami', {});
        if (me.status) return httpFailure(me.status, undefined, { id });
        if (!me.ok) return httpFailure(503, undefined, { id });
        if (message.method === 'tools/list') {
          return reply(id, { tools: toolsForAreas(Array.isArray(me.data?.areas) ? me.data.areas : []).map(mcpTool) });
        }
        const requested = params.protocolVersion;
        return reply(id, {
          protocolVersion: MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: instructions(me.data),
        });
      }
      case 'tools/call': {
        const tool = typeof params.name === 'string' ? HERMES_TOOL_MAP.get(params.name) : undefined;
        if (!tool) return rpcError(id, -32602, 'Unknown tool.');
        const args = params.arguments ?? {};
        const problem = checkArguments(tool.inputSchema, args);
        if (problem) return reply(id, toolError(problem));
        const result = await callDatabase(context, key, tool.name, args);
        if (result.status === 401 || result.status === 503) return httpFailure(result.status, undefined, { id });
        if (result.status === 429) return reply(id, toolError('Too many requests. Try again in one minute.'));
        if (result.status) return httpFailure(503, undefined, { id });
        return reply(id, result.ok ? toolText(result.data) : toolError(result.toolError));
      }
      default:
        return rpcError(id, -32601, 'Method not found.');
    }
  } finally { admission.release(); }
}
