# Application quality review — 11 September 2026

Four agents tested frontend rendering and behavior, data access and database permissions, attendance/API/report correctness, and integration/mobile behavior. Reproduced defects were fixed and tested against independent expected results. No hosted database migrations, live biometric synchronization, emails, or production HR writes were performed.

**Role follow-up:** the initial browser pass below used Super Admin. All seven roles have since been tested explicitly, with 315 mobile route/subtab checks, 995 real PostgreSQL assertions after 127 migration files, and 249 additional local HTTP requests. The updated frontend/service suites pass 646 and 163 tests. See the [role testing report](ROLE_TEST_REVIEW_2026_09_11.md) for exact coverage, additional fixes, and environment boundaries. This later database replay extends the targeted database coverage described below.

## Verified results

| Method | Result | What the result establishes |
| --- | --- | --- |
| Frontend unit, query-contract and rendered-component tests | **588 passed; 0 failed** | Arithmetic, scopes, date handling, imports, pagination, rendered row bounds and failure behavior |
| Attendance engine and real HTTP request tests | **162 passed; 0 failed** | Attendance credits, authentication, authorization, validation, endpoint paging and error responses |
| Disposable PostgreSQL account-integrity suite | Passed | Identity linking, password gate, scoped/ranked roles, function grants and last-admin protection |
| Disposable PostgreSQL workflow suite | Passed | Atomic shift rollback, future assignment preservation, assignment-only role, company/branch restrictions, real foundational RLS and goal-definition protection |
| Actual report SQL and serialized/reopened Excel files | Passed, **503 employees** | Exact workbook values, totals, duplicate device mappings, historical employees, empty scopes and export-column variants |
| Engine scale fixture | **15,593 employee-days** checked in approximately **1.32 seconds** | Expected work, credit and overtime results for 503 staff across a month |
| Workbook generation and save/reopen | Approximately **360 ms** locally | Register and payroll workbook correctness for the synthetic report dataset; not network response time |
| Browser smoke | **45 routes/subtabs plus keyboard skip passed at 320px**; initial 30-screen desktop sweep passed | Rendering, routing, selected known totals and main-content overflow against 525 synthetic employees |
| Additional browser behavior | Passed | Final roster page, employee-code search, drawer dismissal, keyboard skip, correction validation/write failure, older chat retrieval and failed roster reads |
| Builds and static checks | Passed | Web build, attendance typecheck/build, Prisma generation and lint; existing lint warnings remain |
| Dependency audit | **0 advisories** in root, web, database-tooling and attendance production dependency audits | Registry audit state when checked; not a guarantee of absence of undisclosed vulnerabilities |
| Capacitor assets and doctor | Passed for Android and iOS | Web assets copied into both shells; native compilation was not available |

The desktop fixture dashboard produced exactly **525 employees, 420 present and 105 absent**. Searching `EMP0525` returned exactly one employee. Phone Directory pagination reached **517–525, page 44 of 44**. A 250-message conversation initially omitted its oldest message, then exposed message 1 after “Load older messages,” retained message 250, and removed the history button when no older page remained.

The 390px browser pass found Organisation and Audit Log overflow; both were fixed and passed the subsequent 320px sweep. The correction screen also measured exactly 320px content width without horizontal overflow. The new-message dialog measured 318px wide within that viewport. A later login/logout check and viewport-reset attempt were blocked by an open Chrome extension panel; those additional interactions are not claimed as verified.

## Fixes delivered

- **Attendance and payroll outputs:** corrected per-day overtime rounding drift, duplicate payroll employees with multiple device codes, exclusion of historical inactive employees, missing-punch summary differences, half-day paid/unpaid allocations, empty-scope widening and numeric-first-column totals. Flexible-shift half-day unpaid leave now receives 0.5 credit instead of 1.0.
- **API correctness and security:** replaced a collidable 32-bit authentication cache key with bounded SHA-256 caching; rejected malformed bearer headers and impossible dates; caught asynchronous Express failures; enforced mapping scope and added explicit page/count responses while retaining the existing unpaged response format.
- **Complete data retrieval:** removed silent API row-limit truncation from roster/reference and bounded operational queries. Tests exercise 2,025 rows under a simulated 97-row response cap. Collection boundary checks reject the reproduced concurrent-deletion/sort movement instead of silently omitting a person. Related-record queries split long identifier filters into batches.
- **Atomic shift changes:** a failed replacement no longer leaves the original shift removed. A bounded assignment preserves unrelated future shifts. A custom shift-assignment role can use the operation without receiving employee-record read access; company, branch and existing-assignment permissions are checked explicitly.
- **Goal permissions:** employee progress updates remain available; changes to goal definitions, assignment/ancestry and dropped status require management authority. UI controls mirror those restrictions.
- **Phone usability and scale:** searchable, paginated attendance exceptions/corrections, Team lists, goal lists, task assignees, chat pickers, group members and Chat Monitor. Shared phone pagination has First/Last controls and 44px targets. Directory's optional statistics collapse on phones so search and people appear earlier. Organisation and audit controls fit narrow screens.
- **Feedback and navigation:** correction forms validate missing times and expose mutation failures; request status/decision information is visible. Keyboard “Skip to content” preserves the hash route and focuses main content. Failed employee reads show unavailable totals instead of a misleading zero.
- **Chat history:** bounded cursor pages expose older messages; prepending history preserves scroll position. Tests cover 675 messages with tied timestamps and concurrent arrivals, plus a 675-member group alongside 675 other conversations. Monitoring remains read-only.
- **Imports and dates:** spreadsheet parsing preserves zero-prefixed CSV codes and phone numbers, retains Excel calendar dates in the user's timezone, and reports invalid dates with the spreadsheet row. The patched SheetJS 0.20.3 distribution follows the [publisher's installation instructions](https://docs.sheetjs.com/docs/getting-started/installation/frameworks/). Actual XLSX, XLS and CSV roundtrips cover 525 staff; the parser remains lazily loaded.
- **Other data corrections:** personal dashboard payslip queries are scoped to the employee; shared-assignee task counts are correct; failed notification lookups no longer hide actionable items; stale or unauthorized mutations report failures.

## Reproducing the checks

From the repository root:

```sh
npm run verify
```

This runs both application suites, disposable database/report fixtures, frontend lint/build and attendance typecheck/build. PostgreSQL tools (`initdb`, `pg_ctl`, `createdb`, `psql`) must be on `PATH`; fixtures create private temporary clusters and do not read the hosted connection configuration.

For the isolated browser dataset:

```sh
npm --prefix web run qa:browser
```

Open `http://127.0.0.1:5174`. Expand **QA · 525 synthetic employees** and run the smoke checks. The separate QA server replaces the data client only in this configuration, disables hot reload during checks, blocks external connections with a content policy and refuses mutations. Its fixture adapter tests presentation; it is not an implementation of PostgREST or RLS. “Simulate read failure” reloads into a separate synthetic cache identity. Reload manually after source changes.

## Rollout and verification boundaries

Apply the pending database migrations before releasing the frontend's new shift workflow:

```sh
npm --prefix web/backend run migrate
```

The new files are `0121_atomic_shift_assignment.sql` and `0123_goal_progress_guard.sql`. They were tested locally and **have not been applied to the hosted database**. Review the pending migration list in the target environment; the migration command applies all pending files.

These results establish correctness and usable bounded rendering for the synthetic headcounts tested. They are **not a 500-concurrent-user production load test**. Hosted Supabase policies across the entire migration history, deployment behavior, live BioTime/device ingestion, real email/password-reset delivery, realtime delivery across physical devices and production network latency still need staging verification. Database fixtures cover targeted workflows using real foundational policies rather than the complete hosted environment.

The machine has command-line developer tools but lacks full Xcode and a Java runtime. Android/iOS compilation, simulator/device installation, native keyboard/safe-area behavior and device-specific permissions therefore remain unverified. Capacitor assets and doctor checks pass. No application deployment was performed.
