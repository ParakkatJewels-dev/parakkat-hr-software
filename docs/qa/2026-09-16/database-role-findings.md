# Database and role QA — 16 September 2026

Result: the existing database suite passed, but additional adversarial tests reproduced **six defect families**. No application code, migrations, production records or original fixture files were changed.

## Execution and evidence

The existing `web/backend/scripts/testDatabase.js` ran from a temporary copy of scripts, migrations, tests and `web/src/test`. That matters because its role runner normally rewrites tracked JSON fixtures. The copy included the user's existing uncommitted changes, including migration 0141. PostgreSQL ran in a fresh temporary cluster with a private UNIX socket and no TCP listener. Neither runner reads `.env` or a hosted connection URL. Clusters were stopped and removed after each run.

| Test | Result | Evidence |
| --- | --- | --- |
| Original database runner | Exit 0; 34 reported PASS groups | [database-baseline.log](database-baseline.log) |
| Complete migration replay | 144 migration files passed | Original runner and supplemental runner |
| Standard role matrix | 1,259 exact SQL assertions passed | Role matrix summary in both logs |
| Supplemental probes | 55 checks: 44 passed, 11 failed | [database-extra-results.json](database-extra-results.json), [database-extra.log](database-extra.log) |
| Supplemental failure classification | 9 failing cases across 6 confirmed defects; 2 account-revocation observations needing policy confirmation | Details below |

The 34 PASS groups are contract groups, not a count of individual assertions. Do not add 34 to 1,259 as if these were separate test cases. Supplemental exit code 1 intentionally means expected safeguards failed; exit code 2 means the probe harness did not complete. The final run exited 1 and produced all 55 results.

Reproduce supplemental checks from the repository root:

```sh
node docs/qa/2026-09-16/run-database-extra.cjs
```

The reusable runner copies fixtures before invoking `testRoleMatrix`, replays all migrations, performs the original 1,259 assertions and leave workflow suite, and then runs [database-extra-probes.sql](database-extra-probes.sql). Successful trial writes are rolled back inside each probe; seed data exists only in the disposable cluster. The resulting JSON contains exact expected and actual values for every supplemental assertion.

## Personas and scope boundaries

| Login persona | Added designation | Granted scope |
| --- | --- | --- |
| Super admin | Group Director | Global |
| Entity admin | Company Director | Company A |
| HR manager | HR Manager | Company A |
| Zonal manager | Zonal Sales Manager | Zone 1 |
| Branch manager | Store Manager | Branch 1 |
| Department head | Department Supervisor | Department 1 |
| Employee | Sales Associate | Self |
| Linked login without a role | Unassigned Clerk | None |

The original matrix additionally tests anonymous access. Five peer employees distinguish same department, different department/same branch, different branch/same zone, different zone/same company, and another company. Each persona has a separate employee record and login identity. The supplemental suite gives the personas actual distinct `designations` records and checks that an employee cannot change their own designation.

Existing contracts cover user creation/linking, rank and grant boundaries, last-super-admin protection, temporary passwords, shift assignment rollback, goal definition protection, 1,205-row team selection, chat/request/receipt/search/typing/privacy behavior, department ticket routing, named routine scheduling/history, navigation counts, developer API key lifecycle and entity isolation, staged leave decisions/history/balances/locks, and exact standard-role access to employee, attendance, leave, expense, task, goal, payslip and role-administration data.

The supplemental suite adds **40 passing exact row-set checks** for personal documents, exits, jobs, candidates and onboarding across all eight linked personas. Ordinary employees and line managers do not gain colleagues' personal documents; HR and administrators remain inside their company boundaries. Ordinary employees cannot access recruitment/onboarding rows. Exit self-read for a linked but unassigned login is an existing explicit policy, recorded as passing that policy rather than treated as a surprise.

## Confirmed defects — leave unfixed for review

### DB-01 — High: employees can submit expenses already Approved or Paid

- Persona: employee / Sales Associate, with `expense.create` at self scope and no `expense.approve`.
- Reproduction: insert their own `expenses` row with `amount=100` and `status='Approved'`; repeat with `status='Paid'`. See supplemental SQL lines 86 and 89.
- Expected: reject privileged starting states, or force the new request into an allowed submission state.
- Actual: both rows are accepted with their supplied status: `{"amount":100,"status":"Approved"}` and `{"amount":100,"status":"Paid"}`.
- Impact: the server accepts a completed approval/payment state without a reviewer. No actual payment transfer was attempted.
- Cause locations: `web/backend/supabase/migrations/0007_rls.sql:100` only checks `expense.create`; `0072_no_approving_your_own_request.sql:38` attaches its self-approval guard only to UPDATE. `0006_modules.sql:30` supplies a default, not an enforced starting state.

### DB-02 — High: employees can insert an already-approved attendance correction

- Persona: employee / Sales Associate, without `regularization.approve`.
- Reproduction: insert their own `attendance_regularizations` row for 16 September 2026, 09:00–17:30 IST, with `status='Approved'`. See supplemental SQL line 102.
- Expected: request begins Pending and an authorized reviewer approves it.
- Actual: insertion returns `{"status":"Approved","work_date":"2026-09-16"}`.
- Impact: a payroll-relevant attendance correction can enter the approved state without review. This probe validates the stored state; it does not claim that a live payroll run was changed.
- Cause locations: `web/backend/supabase/migrations/0014_leave_regularization.sql:431` checks creation scope only; `0072_no_approving_your_own_request.sql:43` guards UPDATE only.

### DB-03 — High: expense filer identity is writable and the filer-approval rule can be bypassed

- Personas: employee / Sales Associate and branch manager / Store Manager.
- Reproduction A: the employee submits an expense with `created_by` explicitly set to the HR manager's login UUID. See supplemental SQL line 95.
- Actual A: the server stores the supplied HR UUID instead of the actual caller.
- Reproduction B: for a pending target employee claim filed by the branch manager, execute `UPDATE expenses SET status='Approved', created_by=NULL WHERE id=<claim>`. See supplemental SQL line 125.
- Expected: filer identity is server-controlled and immutable; a filer cannot approve their own submission for another employee.
- Actual B: the update returns `{"status":"Approved","created_by":null}`. A control using the same manager and row without clearing `created_by` correctly raises SQLSTATE 42501.
- Cause locations: `web/backend/supabase/migrations/0087_nobody_approves_what_they_filed.sql:32` only defaults the caller; line 74 checks **new** `created_by`, which the same update can erase. `0007_rls.sql:102` does not restrict editable columns.

### DB-04 — High: changing expense states bypasses the self-approval guard

- Persona: branch manager / Store Manager with a pending expense belonging to themselves.
- Reproduction A: set the expense directly from Pending to Paid. See supplemental SQL line 111.
- Reproduction B: set Pending to Draft, then Draft to Approved. See supplemental SQL line 114 and `audit_test.approve_own_through_draft()`.
- Expected: a manager cannot approve or mark their own claim paid without an independent decision.
- Actual: A returns `{"status":"Paid"}`; B returns `{"status":"Approved"}`. Direct Pending → Approved correctly raises SQLSTATE 42501 in the control test.
- Cause location: `web/backend/supabase/migrations/0087_nobody_approves_what_they_filed.sql:63` only guards transitions **from Pending to Approved/Rejected**. It neither checks Paid nor approvals reached from another state.

### DB-05 — High: employees can create an exit record with all clearances already approved

- Persona: employee / Sales Associate, with self-service `exit.create` and no `exit.manage`.
- Reproduction: insert their exit with `status='Completed'` and `approvals={"IT":"Approved","Admin":"Approved","Finance":"Approved","HR":"Approved"}`. See supplemental SQL line 98.
- Expected: server-controlled initial clearance status; department decisions require authorized management actions.
- Actual: the complete submitted status and approval map are accepted unchanged.
- Cause locations: `web/backend/supabase/migrations/0010_modules2.sql:126` defines defaults only; line 180 allows any inserted field values provided the employee scope matches.
- UI relevance: `web/src/components/HelpdeskExit.jsx` displays these stored statuses and treats Completed/Cleared requests as closed. Its regular form omits privileged fields, but that does not enforce the rule at the database boundary.

### DB-06 — Medium: negative expense claims are accepted by the database

- Persona: employee / Sales Associate.
- Reproduction: insert an own Pending expense with `amount=-100`. See supplemental SQL line 92.
- Expected: reject an invalid negative claim amount; the regular input itself declares `min="0"`.
- Actual: `{"amount":-100,"status":"Pending"}` is accepted.
- Impact: invalid claims can reduce expense summaries and reach approval queues through a direct authenticated write.
- Cause location: `web/backend/supabase/migrations/0006_modules.sql:26` defines `numeric not null` without a non-negative constraint. UI validation at `web/src/components/Expense.jsx:128` does not cover direct API/database requests.

## Account-revocation observations requiring a policy decision

Two probes intentionally ask whether deactivation immediately removes access for an already authenticated identity:

1. Set the HR employee's status to Inactive, retain the established login identity, and select peer employee records: **4 records still returned**.
2. Set the HR login's `auth.users.banned_until` to tomorrow, retain that identity, and repeat: **4 records still returned**.

The expected immediate-revocation value was 0, so both are counted as failed probes, but they are **not included among the six confirmed defect families** until the intended lifetime of existing access tokens is decided. This test does not perform fresh hosted sign-in or token refresh. Core `app.has_perm` and `app.is_super_admin` in `0005_functions.sql` do not consult active/ban state, while `0141_section_counts.sql:20` explicitly requires an active actor. Review whether that inconsistency is intentional and document the required revocation delay.

## Limits and remaining coverage

- This is current source against a local Supabase SQL shell, not a claim about migrations actually deployed to production.
- Real hosted Auth sign-in/recovery/MFA/session expiry, PostgREST transport, Storage HTTP, Realtime delivery and external notifications were not exercised here.
- Standard role scopes and several negative controls are covered; arbitrary custom-role combinations and every multi-scope assignment are not exhaustive.
- Recruitment, onboarding, documents and exits have new exact read tests; full create/edit/delete lifecycle, uploads and external integrations for those modules remain outside these extra probes except the exit defect above.
- Asset custody/returns/retirement, every payroll-generation scenario, live BioTime sync, native mobile behavior and every visual UI control are not established by this database lane. Other QA lanes may supply additional coverage.
- Supplemental denial helpers report actual SQL errors; the passing denial controls here were explicitly verified as SQLSTATE 42501. No infrastructure error is being presented as a successful permission denial.
- An early supplemental seed omitted mandatory document content and was corrected in the QA fixture; a report-parser filter was also corrected before the final complete run. These were QA harness issues, not application defects.
