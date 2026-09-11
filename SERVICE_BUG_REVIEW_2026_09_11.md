# Attendance service bug review — 11 September 2026

Four agents audited the BioTime transport/sync pipeline, attendance engine and database queue,
service runtime/API/reports, and queued commands. The existing 163-test service suite passed before
the audit. New regressions reproduced additional defects; the fixes below are in the workspace.
No live sync, hosted database write, deployment or device operation was performed.

## Confirmed defects and fixes

| Area | Reproduced behavior | Fixed behavior |
| --- | --- | --- |
| Incomplete ingestion | Cancellation, page-budget exhaustion and some malformed HTTP 200 responses could end pagination as though complete | Fail explicitly and preserve the cursor for retry; short capped pages continue while more rows are advertised |
| Late and historical punches | Catch-up/backfill skipped recompute enqueueing; overnight exits omitted the previous work date | All import modes enqueue affected dates and the prior day needed for overnight attendance |
| Sync persistence failures | Queue writes could fail while the cursor advanced; employee-map reads could leave an open run | Queue failure prevents advancement; loader failures close the run as failed |
| Cursor races and IDs | A stale concurrent update could rewind the cursor; large transaction IDs could lose precision | Atomic monotonic SQL update and validated bigint conversion |
| Roster failures | Terminal auth/network failures could look like successful empty results; cancellation could allow more writes | Only unsupported optional endpoints use the empty fallback; cancellation stops subsequent mutation steps |
| Recompute queue | Future entries blocked due work or were acknowledged before their date; newly queued corrections were lost during an older run | Due-date filtering and generation-based acknowledgment retain future and newly changed requests |
| Attendance correctness | Failed regularization reads could replace approved attendance with device-only output; deactivated shifts broke historical assignments | Required reads fail before rewrites; historical assigned shift rules remain available |
| Concurrent recompute | An older snapshot could overwrite a newer result | Recompute calls serialize within the service process; cancellation stops later batches and acknowledgments |
| Queued permissions | Work could run after requester authority was revoked; entity-level operational commands were admitted for global work | Revalidate current grants before execution; migration 0127 also rejects scoped global operations at enqueue time |
| Queued input/output | Invalid dates, empty employee selections and malformed branch selections could reach work or widen filters | Validate actual queued parameters; preserve intentional all-branch exports and valid selected employees |
| Queued backfill scale | A month-long request used one default-sized pagination window despite claiming weekly chunks | Weekly windows with the historical page budget, exact inclusive bounds, cancellation between windows and aggregated output totals |
| Command completion | Late cancelled work could report success over an expired status | Cancellation checks plus updates conditional on the row still being running; export byte metadata uses decoded bytes |
| Runtime lifecycle | Synchronous job errors leaked locks; startup/abandoned work escaped shutdown tracking; API-only replicas reconciled other workers' rows | Track startup and abandoned jobs, release failed setup locks, abort/drain work on shutdown, and restrict reconciliation to workers |
| Detached HTTP work | A 202 response ended shutdown tracking while its background import/rebuild was still active | Track each accepted job until it settles, abort between work chunks, drain before database disconnect, and refuse new shutdown-time requests with 503 |
| Report calendar dates | A database July 1 date could render as June 30 in western timezones | Treat database DATE values as calendar dates; a 675-employee fixture verifies exact register values |

The API also rejects reversed recompute ranges before scheduling; the engine/CLI's intentional
backward-range normalization remains available.

## Output and regression evidence

- **211 service tests pass**, including ingestion, queued-command, runtime and shutdown regressions.
  Service typecheck and build pass. Combined root verification also passed **683 frontend tests**,
  database/report/engine fixtures and lint/build checks. The final mobile photo regression update
  was followed by a successful **686-test frontend** run plus lint/build; existing lint warnings remain.
- The real PostgreSQL engine suite passes **8 integration tests**. Its 503-employee fixture checks
  **1,005 retained attendance rows**, **1,004 × 480 worked minutes**, a preserved payroll-locked row
  and pre-hire cleanup. A cancellation test stops after the first 400-row batch and verifies that
  retry completes all 503 employees. Queue race and concurrent-run tests use actual SQL writes.
- The database role suite passes **1,163 assertions after 131 migration files**, including 56 new
  operational-command admission checks across seven roles and an unassigned account, plus the
  subsequent group-identity regression checks.
- The existing **249 local HTTP role requests** and actual 503-employee report SQL/XLSX suite pass.
  The HTTP identity provider remains mocked with permissions from the migration replay.
- Twenty-four new sync/transport tests cover the ingestion failures. The actual cursor SQL was
  additionally checked in a temporary PostgreSQL cluster with 25 concurrent stale updates and the
  exact bigint 9007199254740993. No cursor rewind or rounding occurred.
- Thirteen command-worker tests cover current authority, malformed selections, cancellation,
  status fencing, valid binary exports, and complete month-to-week splitting. The July fixture
  covers all 31 dates exactly once in five windows and independently checks aggregate counts.

Run `npm run verify` from the repository root for the combined database, frontend, service,
build and static checks. It now includes `npm --prefix services/attendance run test:engine`.
PostgreSQL command-line tools must be installed for database fixtures. All fixture clusters use
synthetic data and are removed after testing.

## Rollout and limits

Apply `0126_recompute_queue_generations.sql` and `0127_service_command_authority.sql` using the normal
backend migration runner **before restarting the updated worker**. These migrations have only been
tested locally. The first adds the queue generation column the worker reads; the second aligns
operational queue admission with the worker's global permission requirement.

Continue to deploy **one worker process**. The recompute serializer is process-local and does not
claim distributed coordination. An aborted or failed run may have committed earlier idempotent
batches; retry completes the work. A hung database call cannot be forcibly interrupted by a
JavaScript signal, so shutdown still has its bounded final deadline.

The fixtures verify code paths and exact outputs, not live BioTime behavior, production network
conditions or deployed service health. Production latency and concurrent-user capacity have not
been benchmarked in this pass. Full historical migration replay supplies the previously documented
GN-shift prerequisite and a minimal Supabase SQL platform shell.
