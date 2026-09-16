# Local HRMS fixes and verification — 16 September 2026

The user authorized fixing the audit findings and kept the work isolated locally. All **21 confirmed defects** and the **FE-09 clearance workflow gap** are implemented. The four policy observations are resolved using the user's answers. The original [bug register](../BUG_REGISTER.md) retains the pre-fix reproductions; original evidence was not overwritten.

**Migration follow-up:** a user-run deployment exposed a Storage metadata ownership condition
that the initial local fixture did not model. Migration 0144 now restricts its policy scan to
application tables and Storage file objects. See the [ownership correction and retry instructions](migration-0144-ownership/README.md).

## Fix status

| Findings | Implemented behavior | Main regression evidence |
| --- | --- | --- |
| DB-01–06 | New expenses and corrections start Pending; filer/reviewer identity is server controlled; self/filer decisions and approval-state bypasses are rejected; expenses must be finite and nonnegative; exits cannot arrive pre-cleared | `web/backend/tests/request_integrity.sql`; [database run](database-tests.log) |
| PAY-01–04 | Absence/half-day fractions reduce pay; fixed components honor proration; incompatible earning breakdowns fail atomically instead of inflating gross; publication exposes Published payslips and lines | [33 payroll assertions and details](payroll-fixes.md) |
| ATT-01–03, ATT-05 | Approved endpoints preserve real evidence, rebuild sessions/breaks and clear resolved exceptions; forms support explicit next-day checkouts; display/CSV summaries use corrected timelines | [242 service tests](attendance-unit.log), [10 engine integration tests](attendance-engine.log); frontend timeline/form regressions |
| FE-01 | Report failures show errors and retry controls; unverified CSV exports are disabled; incomplete leave allocations also block export | `ReportWorkflowIntegrity.test.js`; [browser workflows](evidence/browser-workflows.json) |
| FE-02 | Monthly leave totals and CSV use actual working days in the selected period, including half-days, cancellations, weekly offs and holidays | `report_input_integrity.sql`; [real CSV output](evidence/leave-period.csv) |
| FE-03 | Branch IDs keep same-code branches separate; company labels distinguish them; stored ancestry supports restricted employee details | `reportRows.test.js`, `ReportWorkflowIntegrity.test.js` |
| FE-05, FE-06 | Rejected and hired candidates remain visible; failed reads show unavailable metrics; an RLS-filtered stage write cannot report success | Recruitment component/form and mutation regressions |
| FE-07 | Failed exit reads block new requests; own open requests remain recognized even if the employee relation is hidden | Component regression and employee browser scope scenario |
| FE-08 | Whitespace-only titles are rejected by the form, mutation and database; valid titles are trimmed | Form/mutation regressions; SQL whitespace cases; browser failed-write draft retention |
| FE-09 | Scoped reviewers can record IT/Admin/Finance/HR decisions and complete an exit only after all four approve; own/filer/out-of-scope actions are blocked; changes are audited | Real SQL lifecycle plus [browser checks](evidence/browser-fix-checks.json) and [mobile clearance](evidence/exit-cleared-390.png) |

Additional review closed zero-row recruitment updates and refreshed leave allocations after local calendar/shift/placement changes. Existing branch/employee realtime events invalidate allocations; calendar settings changed on another device retain the application's bounded polling/focus refresh behavior.

## Confirmed policy choices

- **Inactive or banned accounts:** deny the unchanged identity on the next database/API request. Database RLS and definer helpers enforce this; the attendance API caches only verified identity and rechecks access on every request. Queued work checks the requester when it starts. Deleted accounts are also denied. Unlinked administrative accounts retain their authorized access. Existing browser caches clear when the access RPC refuses the session.
- **Paid half-day leave with unresolved missing punches:** provisional credit remains **0.5**, including unresolved interior gaps. Once the worked half is verified, eligible full credit can be restored. Ambiguous punches remain visible as exceptions.
- **FE-04 headcount:** “Current Active” explicitly means today's roster; joiners and exits remain tied to the selected month.

The chat pin observation was a **fixture serialization issue**, not a confirmed product defect: read responses shared mutable objects with fixture storage. The adapter now clones read data as HTTP serialization would. All six bounded chat/developer flows pass, including unpin → pin → unpin. [Evidence](local-chat-developer-results.json).

## Verification

**1,144 frontend tests passed**, with no failures or skips. Web build and lint passed; lint retains 32 existing warnings. Logs: [frontend tests](frontend-tests.log), [lint](lint.log), [build](build.log). Parallel SSR tests log existing Vite HMR-port warnings; they do not fail the test run.

| Layer | Result |
| --- | --- |
| Frontend | **1,144 tests passed**; production build and lint passed |
| Database | **149 migration files**, **1,259 role assertions**, 38 reported contract groups passed; includes request/revocation/report tests and 33 payroll assertions |
| Attendance service | **242 tests**, **10 database engine integration tests**, TypeScript passed |
| Attendance HTTP roles | **249 requests passed**, using the newly generated 149-migration grant fixture |
| Attendance SQL/XLSX | Passed across **503 synthetic employees**, including serialized/reopened workbook totals |
| Browser routes | **674 checks**, eight personas at desktop/mobile widths, passed |
| Existing browser workflows | **22/22 passed** |
| New targeted browser workflows | **5/5 passed**, plus mobile HR clearance lifecycle |
| Chat/developer flows | **6/6 passed** |

These counts use different units and overlap; they are not summed. Browser identities and persistence are synthetic, while migration/RLS/engine checks use disposable PostgreSQL. All browser external traffic was blocked. [Fresh generated role fixtures](generated-fixtures/standard-role-results.json) are separate from the existing dirty repository fixtures.

## Applying the changes later

No hosted migration, deployment, commit, real account change or communication was performed. Corrective migrations are **0142–0146**, after the existing migration history (including the already pending 0141). Apply pending database migrations before deploying the updated attendance worker and web app: the worker now requires `app.account_is_active`, and reports/clearances require the new RPCs.

Existing published monetary amounts are not recalculated. The payroll migration repairs publication status only for Paid payslips whose run is Published. Historical invalid expense rows are preserved by a NOT VALID constraint; new writes cannot introduce or retain invalid amounts. Any historical monetary/data cleanup needs a separate review of real records.

The original audit's integration limits still apply: hosted authentication/storage/email, real biometric devices, native shells, physical multi-device delivery and production load were not exercised. Passing this correction pass does not claim every possible HRMS workflow or payroll policy has been exhaustively tested.
