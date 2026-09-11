# Role testing follow-up — 11 September 2026

The initial browser audit used Super Admin. This follow-up explicitly exercises all seven standard roles, their permitted and denied screens/actions, and their data scopes. Four agents handled browser integration, rendered UI behavior, database authorization, and attendance HTTP/report outputs, with an independent review of the new task policies.

## Role coverage

| Role | Representative scope | Synthetic people in that scope | Mobile route/subtab checks |
| --- | --- | ---: | ---: |
| Super Admin | Global | 525 | 45 passed |
| Entity Admin | Company | 175 | 45 passed |
| HR Manager | Company | 175 | 45 passed |
| Zonal Manager | Zone | 88 | 45 passed |
| Branch Manager | Branch | 44 | 45 passed |
| Department Head | Department | 22 | 45 passed |
| Employee | Self | 1 | 45 passed |

All **315 route/subtab checks** ran at **390px**. Each role also passed keyboard skip navigation, and a linked account without an assigned role was blocked at the application entry screen. Expected access denials count as successful checks. The fixture has three companies, six zones, twelve branches and twenty-four departments. List totals are checked against separately stated expected counts. [Saved browser results](web/qa/role-results-2026-09-11.json) retain each route's outcome.

The browser also exercised an HR Manager switching to Employee view. The dashboard showed one personal task, the employee's own correction request and a published payslip with net pay **₹20,000**. Direct Directory access was blocked in that view. Returning to HR Manager restored the **175-person** directory. This verifies the presentation switch; it does not change the signed-in account's database permissions.

## Automated evidence

- **646 frontend tests passed**, including 57 role-rendered tests with 133 assertions against real application routes. Coverage includes approval buttons, self-approval exclusions, payroll deep links, goal actions, personal tasks, employee creation/export, subordinate account actions, combined roles, hidden screens, and unlinked/unassigned accounts.
- **163 attendance tests passed**. An additional **249 real local HTTP requests** checked all seven roles using grants exported from the rebuilt database. They verify exact authorized employee IDs, JSON report totals, serialized/reopened XLSX files, branch/zone/company denials, recompute targets, diagnostics, mapping and management endpoints. Missing, invalid, unassigned and unlinked identities are also covered.
- The database suite passes **995 assertions** after replaying **127 application migrations** in a disposable PostgreSQL cluster. It tests actual RLS and successful/denied writes for employee records, attendance, leave, expenses, tasks, goals, published/draft payslips and role administration. Successful trial writes are rolled back. Counts by role are saved in [the SQL results fixture](web/backend/tests/fixtures/standard-role-results.json).
- The earlier **503-employee** SQL/XLSX and **15,593 employee-day** attendance fixtures remain in the integrated verification command.
- `npm run verify` passed: application suites, database/report/HTTP role fixtures, lint, web build and attendance typecheck/build. Lint has existing warnings.

## Fixes from this pass

- Scoped attendance managers can no longer read organisation-wide device/service diagnostics. A denied diagnostics request is distinguished from a connectivity failure in the UI.
- Mixed company-plus-branch export grants retain company employees who have no branch assigned. Explicit empty recompute selections are rejected instead of selecting everyone.
- Scoped administrators can revoke subordinate role assignments using the application's returned-row workflow; the database now exposes exactly the grants they are already authorised to manage.
- Task ownership and delegation fields are protected from assignee impersonation and changes outside the manager's scope. Foreign-parent assignments are denied and task ancestry comes from the assignee's actual hierarchy. Shared-task progress, valid delegation and the checked help-request workflow remain functional.
- Dashboard approval totals, priorities and inline decisions use the same per-request permission checks. They exclude self-approval and expenses filed by the viewer. Failed decisions remain visible. Department and branch approval totals changed from **44 → 42** and **88 → 86** in the fixture; company pending leave changed from **175 → 174**. HR month-to-date joiners exclude future hires.
- Directory CSV exports correctly handle embedded quotes, commas and newlines, retain the existing formula protection, and release the download URL. An exact 525-row roundtrip verifies the output.
- Migration `0119` now rebuilds its view before changing column order, fixing the reproduced fresh-replay failure.

## Reproduction and boundaries

Run `npm run verify` from the repository root. PostgreSQL command-line tools must be on `PATH`. The database suite exports the current standard-role grants before the attendance HTTP and rendered frontend role suites run. See [backend test details](web/backend/README.md#local-database-verification).

For browser checks, run `npm --prefix web run qa:browser`, open `http://127.0.0.1:5174/?qa-role=employee`, expand **QA · 525 synthetic employees**, select a role, and run the screen checks. The separate fixture server blocks writes and external connections. It tests real application presentation with synthetic responses; its adapter is not an implementation of RLS.

These are **isolated role tests, not seven live staging login-to-completion sessions**. PostgreSQL uses a minimal Auth/Storage SQL shell; the service's Supabase identity verifier and external device/jobs are mocked. Hosted authentication, PostgREST/Storage HTTP, realtime delivery, real password emails and physical-device behavior remain unverified. Standard scopes and selected combined-role cases are covered; arbitrary custom-role combinations are not exhaustive. This is also not a 500-concurrent-user production load test.

Historical migration `0062` expects a preconfigured `GN` shift, which the fixture supplies before replay. The existing `0113` personal-root-task exception is preserved and explicitly tested: a linked login without an assigned role can insert its own root task without returned rows, but cannot read/update it or enter the UI.

New migrations `0124_role_revoke_visibility.sql` and `0125_task_assignment_guard.sql` have been tested locally and **have not been applied to the hosted database**. No deployment, production HR write, device call or email was performed.
