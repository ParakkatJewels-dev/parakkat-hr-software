# Developer API

Super admins manage integration access at **Administration → Developer Settings**. API access
starts disabled. Create a named key, select its read permissions and company, copy the key once,
then enable API access when the integration is ready. **Copy key** is available in the creation
panel and beside the new key until you hide it. If clipboard access is unavailable, the app
selects the complete key for manual copying. The app never displays a saved key again.
Use **Create replacement** beside a saved key to prefill its permissions and company, copy the
new key into your integration, then revoke the old key. Replacement does not revoke it automatically.

## Deployment

1. Apply `0135_developer_api_keys.sql` with the normal `npm --prefix web/backend run migrate` runner.
2. Deploy `web` to Vercel, including `api/v1/[resource].js` and the API rewrite in `vercel.json`.
   A plain static `dist` upload or Vite development server does not execute these Node functions.
3. The function reads `SUPABASE_URL` and `SUPABASE_ANON_KEY` from its runtime environment,
   falling back to `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Use the project's public
   anon/publishable key. The gateway does not require or use a service-role key.
4. Optional `VITE_PUBLIC_APP_URL` sets the canonical web address shown in the guide, including
   when an administrator opens the native app. Otherwise the current web origin is used.

No key is created and API access is not enabled by deployment. Ordinary HR sign-in, permissions
and attendance ingestion keep their existing authentication paths.

## Requests

Base URL: `https://parakkat-hr-software.vercel.app/api/v1` (use your own deployment origin).
Authenticate with the integration key in the `Authorization` header, never in the URL:

```bash
curl 'https://parakkat-hr-software.vercel.app/api/v1/employees?limit=50&offset=0' \
  --header "Authorization: Bearer $HR_API_KEY"
```

| Endpoint | Required permission | Returned data |
| --- | --- | --- |
| `GET /employees` | `employees:read` | Work directory and organization placement |
| `GET /organization` | `organization:read` | Organization records distinguished by `kind` |
| `GET /attendance?from=2026-09-01&to=2026-09-14` | `attendance:read` | Daily attendance summaries |

All endpoints accept `limit` (default 50, maximum 100) and `offset` (default 0, maximum
1,000,000). Attendance requires valid ISO calendar dates and an inclusive range of at most 31
days. Unsupported parameters, methods and resources are refused. These endpoints are designed
for server integrations; they do not offer cross-origin browser access.

Successful responses share this envelope:

```json
{
  "data": [],
  "pagination": { "limit": 50, "offset": 0, "has_more": false }
}
```

Increase `offset` by `limit` while `has_more` is true. Ordering is stable within each resource,
but offset pagination is not a snapshot: records can change between requests.

| HTTP status | Meaning |
| --- | --- |
| 400 | Invalid parameters or date range |
| 401 | Missing, invalid, expired or revoked key |
| 403 | Key lacks the requested permission |
| 404 | Unknown endpoint |
| 405 | Unsupported method; use GET |
| 429 | A key, gateway request, or concurrent-work budget has been reached; wait for `Retry-After` |
| 503 | API access is disabled or the service is unavailable |

Error responses use `{ "error": { "code": "unauthorized", "message": "A valid API key is required." } }`.
The gateway returns `Cache-Control: no-store` for every response and does not return database
details or submitted keys.

## Access controls

Keys have 256 bits of cryptographic randomness. Only the SHA-256 hash and a display prefix are
stored. Management RPCs require an authenticated super admin; private key/settings tables have
no anonymous or authenticated table grants. Key metadata is excluded from persistent browser
query storage, and generated plaintext bypasses all query and mutation caches.

Every data request rechecks the master switch, hash, expiry, revocation, creator's current
super-admin authority, allowed resource and optional company boundary. Banned or removed
creators cannot keep access through old keys. Revocation and disabling access take effect on
subsequent requests; they cannot undo data an integration has already downloaded.

The SQL reader enforces these checks even if someone calls its PostgREST RPC directly, bypassing
the Vercel gateway. Each key is limited to 60 successful requests per minute. Responses use
explicit field lists: API keys do not grant salary, banking, statutory ID, private message,
document or raw-punch access. Company restrictions cannot become global access when a company
is deleted. Key creation/revocation and access-setting changes are audited without secrets.

The Node gateway also refuses excess work **before contacting PostgreSQL**: each warm function
instance admits at most 60 attempts per key and 600 total attempts per minute, with 32 upstream
requests in flight. Invalid credentials that reach the gateway consume this attempt budget too.
Its key map stores hashes only, has a fixed capacity, and resets after one minute. HTTP 429
includes a decreasing `Retry-After` in seconds; concurrency exhaustion uses 5 seconds. An
upstream call releases its slot on success, failure, or its existing 8-second timeout.

The warm-instance limit is an additional load reduction, not a distributed quota: cold starts
and separate instances have separate counters. The SQL key quota remains authoritative across
instances and direct RPC calls. No successful authorization or employee response is cached, so
each admitted request still rechecks expiry, revocation, current authority and company scope.
Arbitrary distributed requests to Supabase or the gateway require platform ingress controls;
these source changes do not modify hosted rate-limit settings.

## Verification

`npm --prefix web test` exercises client validation, secret-safe errors, role navigation, rendered
settings and the HTTP gateway. `npm --prefix web/backend test` verifies key issuance, database
permissions, scope isolation, expiry, revocation, master disable and rate limiting in a disposable
local PostgreSQL cluster. The optional `?qa-developer` preview uses synthetic keys and in-memory
settings; it never creates a production credential.

## AI assistants (Hermes)

Managers can connect an AI assistant such as [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)
to manage day-to-day work from chat. Unlike the read API above, an assistant key **acts as the person
who created it**: every action is recorded under their name and is limited to exactly what their
role already allows in the app. Attendance, payroll, documents and employee/company setup are not
reachable, and **no tool deletes, trashes or removes anything**; work is closed by changing its status.

### Setup

1. Apply `0168_hermes_agent_api.sql` with the normal migration runner and deploy `web` (it adds
   `api/mcp.js`). Assistant access starts **off**.
2. A super admin turns on **AI assistant access** in Administration → Developer Settings. This switch is
   separate from the read API switch.
3. In Administration → Roles, the super admin ticks **Connect an AI assistant** (`api.connect`) for the
   roles that may use it. Super admins have it by default.
4. The manager opens **Settings → AI assistant**, picks the areas (Tasks & requests, Leave approvals,
   Assets, Goals) and an expiry (7, 30 or 90 days), and creates a key. The key is shown once, together
   with a ready-to-paste block for `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  parakkat_hr:
    url: "https://parakkat-hr-software.vercel.app/api/mcp"
    headers:
      Authorization: "Bearer YOUR_PERSONAL_KEY"
```

5. In Hermes, run `/reload-mcp`. Hermes lists the tools allowed by the key's areas.

Each person may hold up to five active assistant keys and can revoke their own keys in Settings, even
after losing the permission. Super admins see every key, with whose name it acts under, in Developer
Settings and can revoke any of them.

### Endpoint

`POST /api/mcp` speaks MCP over stateless Streamable HTTP: one JSON-RPC message per request, one JSON
reply, no session and no server-sent stream. Supported methods are `initialize`, `ping`, `tools/list`
and `tools/call`; notifications receive `202`. Requests with an `Origin` header (browsers), batches,
bodies over 64 KB and unknown `MCP-Protocol-Version` values are refused. A missing, invalid, expired or
revoked key, or a key whose owner lost `api.connect`, gets `401`; assistant access switched off gets `503`.
Problems inside a tool (bad arguments, not permitted, not found) are returned as tool errors with a
plain sentence so the assistant can correct itself.

| Area | Tools |
| --- | --- |
| Always | `whoami`, `find_employees`, `list_departments` |
| Tasks & requests | `list_tasks`, `get_task`, `create_task`, `update_task`, `add_task_helpers`, `comment_on_task`, `add_subtask`, `tick_subtask`, `list_routines`, `create_routine`, `update_routine`, `stop_routine`, `list_help_requests`, `request_help`, `answer_help_request`, `cancel_help_request`, `list_ticket_categories`, `list_tickets`, `create_ticket`, `set_ticket_status` |
| Leave approvals | `list_leave_requests`, `decide_leave` |
| Assets | `list_assets`, `add_asset`, `update_asset`, `assign_asset`, `return_asset` |
| Goals | `list_goals`, `create_goal`, `update_goal` |
| Work Ledger (0172) | `ledger_home`, `ledger_list_tasks`, `ledger_get_task`, `ledger_report`, `ledger_list_ideas`, `ledger_list_reminders`, `ledger_list_campaigns`, `ledger_add_task`, `ledger_update_task`, `ledger_mark_done`, `ledger_log_progress`, `ledger_log_help`, `ledger_add_idea`, `ledger_add_reminder` — only the key owner's own ledger; see [WORK_LEDGER.md](WORK_LEDGER.md) |

Deliberately left out: changing a task's main person (the app does that by removing the old person),
removing helpers, subtasks or routine jobs, the task trash, unticking a routine job, reopening decided
leave, file uploads, and asset licence keys.

### How it is enforced

`public.developer_api_call(_api_key, _tool, _args)` is the only entry point and is granted to `anon`
alone, so SQL is authoritative even when PostgREST is called directly. It:

1. validates the key in `agent_gateway.authorize` (format, assistant switch, hash, kind `manage`, expiry,
   revocation, the owner's account state and current `api.connect`, the tool's area and the 60-per-minute
   key budget);
2. sets `request.jwt.claim.sub` / `request.jwt.claims` to the key owner and switches the role to
   `authenticated` for the rest of the transaction. This is an INVOKER function on purpose: PostgREST's
   login role is a member of `authenticated`, and role changes are not allowed in SECURITY DEFINER code;
3. runs one whitelisted `hr_agent.*` tool. Tools are INVOKER functions executable only by `authenticated`,
   so the app's existing row policies, triggers and checked RPCs (`decide_leave`, `request_department_help`,
   `create_routine_set`, …) apply exactly as they do for the person in the app;
4. restores the original role and identity, and returns `{ok, data}` or `{ok: false, error}`.

Failed tool calls still use the rate budget and are audited (`API_CALL` / `API_CALL_FAILED` in
`audit_log`, with the key id and owner). Responses use explicit field lists; database messages are
reduced to plain sentences.

### Verification

`npm --prefix web/backend test` runs `tests/developer_api_write.sql` after the read API tests. It
simulates PostgREST's login role and checks attribution, scope, every refusal path, identity restoration
after each call, routine-job protection, auditing of failed calls, and that **no row is deleted** by any
assistant action. `npm --prefix web test` covers the MCP protocol (`mcpGateway.test.js`), the tool list
staying identical to the database dispatcher (`hermesTools.test.js`) and the Settings screens. The
`?qa-developer` preview includes synthetic assistant keys that do not work against the real API.

Before the first production rollout, confirm on the hosted project that the PostgREST login role is a
member of `authenticated` (Supabase default) and that `anon`'s `statement_timeout` leaves room for a
write.
