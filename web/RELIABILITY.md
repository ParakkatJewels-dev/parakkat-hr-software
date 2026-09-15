# Loading, recovery and request load

## User experience

- Unknown app routes show a branded 404 with a Home link. Known screens retain their permission
  guards; invalid nested tabs do not silently open an unrelated view. The hosted static `404.html`
  handles unknown document paths without rewriting missing assets or APIs into the app.
- Lazy screens and data reads use labeled skeletons. Shared `FormSection` forms announce saving,
  block duplicate submissions and dismissal while pending, and preserve inputs on failure.
- `QueryError` provides a retry action. Goals, expense claims and leave requests distinguish a
  failed initial read from an empty result; failed refreshes label any retained data as the last
  available data. Required employee/leave-type lookups block submission until they are available.
- Shared inline editors and confirmation dialogs also prevent duplicate actions or dismissal
  while pending. Ticket/category and attendance-correction forms disable editing during saving.
- Validation and permission failures are shown immediately. A rate-limit response asks the user to
  wait; automatic retries never replay a write.

## Browser cache and traffic

`src/lib/queryPolicy.js` owns the query defaults used by every authenticated session:

| Data | Fresh for | Visible-screen safety poll |
| --- | --- | --- |
| Most application data | 1 minute | 5 minutes |
| Employee roster | 2 minutes | 5 minutes |
| Organization reference data | 5 minutes | 15 minutes |
| Employee and asset image URLs | 8 minutes | At 8 minutes from signing, before their 10-minute expiry |
| Chat attachment URLs | 55 minutes | At 55 minutes from signing, before their 1-hour expiry |

Screens such as message delivery and sync status retain their shorter explicit intervals.
Queries with the same key share an in-flight read. Mutations and realtime invalidate matching
data before its freshness period ends. Realtime marks both mounted and unmounted caches stale,
but a hidden app does not refetch them until visible. Older in-flight responses cannot overwrite
those changes. Ordinary fresh data is reused on first socket connection; chat gets one catch-up
when its subscription is ready. Reconnects catch changes missed while disconnected. Restored
signed URLs keep their original renewal deadline, and failed renewals wait a minute before polling.

Transient network/server reads get at most two retries with exponential delay and jitter.
Permission, validation, not-found, rate-limit and other permanent failures do not retry
automatically. This uses the installed query library's [freshness and retry controls](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults).

The existing persisted cache remains restricted to the signed-in user's resolved access scope,
expires after 24 hours, and is cleared on identity/access changes. Corrupt or unavailable storage
does not block startup. Authentication, permission and password gates still resolve before it is
restored.

The PWA caches content-hashed build files without re-downloading them on each route visit. New
filenames fetch the new build. Runtime assets are bounded to 90 entries. API requests, deployment
checks and unknown data endpoints bypass the service-worker cache. A real HTTP 404 remains a
404; standalone documents cannot replace the cached app shell. Network/server outages can still
use the cached shell. The worker never caches cross-origin Supabase responses.

## Server controls and deployment

- The attendance service has bounded per-process/IP/user request budgets, limits concurrent
  expensive work and background jobs, shares concurrent session verification, and caches cheap
  health/diagnostic reads for five seconds. See its [limits and proxy configuration](../services/attendance/README.md).
  If workers are busy, a saved device mapping reports recomputation as queued after its durable
  queue write succeeds. It does not report a failed save or bypass the worker capacity limit.
- The developer integration API rejects excess requests before upstream work within each warm
  instance; its existing PostgreSQL quota remains shared across instances. See the
  [Developer API](backend/DEVELOPER_API.md).
- These service limits do **not** wrap the app's direct Supabase Auth, PostgREST/RPC, Storage,
  Realtime or optional invite function. Project/edge controls for those entrypoints require
  deployment configuration. In-memory limits are process-local and reset on restart.

The reliability changes need a web deployment and attendance-service restart. No additional
database migration is introduced by this work. Configure `API_TRUST_PROXY` only for the actual
trusted reverse proxy; see the service README. Earlier pending feature migrations are separate.

## Verification

- Frontend: `cd web && npm test`, `npm run lint`, `npm run build`.
- Service: `cd services/attendance && npm test`, `npm run typecheck`, `npm run test:roles`.
- Isolated browser fixture: `cd web && npm run qa:browser`. Use `?qa-fail` for failed reads,
  `?qa-slow` for delayed loading/saving, and `?qa-goals&qa-block-write` for a failed goal save.
  The fixture blocks external connections and stores allowed synthetic changes in memory only.
- Service-worker tests exercise cached assets, real/preloaded 404s, offline recovery and
  non-caching of APIs/private data. Query tests count actual loader invocations for cache reuse,
  coalescing, hidden-tab deferral and reconnect refreshes. Server tests cover quota reset,
  permission checks, concurrency release and 429 responses with `Retry-After`.
