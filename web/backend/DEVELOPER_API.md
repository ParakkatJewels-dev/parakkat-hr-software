# Developer API

Super admins manage integration access at **Administration → Developer Settings**. API access
starts disabled. Create a named key, select its read permissions and company, copy the key once,
then enable API access when the integration is ready. The app never displays a saved key again.
Create a replacement key and revoke the old key when rotating credentials.

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
| 429 | Per-key limit of 60 successful requests per minute reached |
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

## Verification

`npm --prefix web test` exercises client validation, secret-safe errors, role navigation, rendered
settings and the HTTP gateway. `npm --prefix web/backend test` verifies key issuance, database
permissions, scope isolation, expiry, revocation, master disable and rate limiting in a disposable
local PostgreSQL cluster. The optional `?qa-developer` preview uses synthetic keys and in-memory
settings; it never creates a production credential.
