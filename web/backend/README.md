# Parakkat HRMS — Backend

This is the **Supabase backend**: there is no long-running server to deploy — Supabase hosts the
Postgres database, auth, and (optionally) Edge Functions. This folder holds everything that defines
and populates that backend.

## Structure

```
backend/
├── README.md                     this file
├── .env.local.example            copy -> .env.local (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
├── CompanyDetails/               source employee rosters (.xlsx) used by the importer
├── scripts/
│   ├── import_employees.py        load rosters -> entities/branches/designations/employees (idempotent)
│   └── create_user.py             provision a login (admin API); optional --super-admin
└── supabase/
    ├── migrations/                ordered SQL — run these in the dashboard SQL editor, in order
    │   ├── 0001_init.sql          extensions, scope_type enum, app schema
    │   ├── 0002_org.sql           entities/zones/branches/departments/designations
    │   ├── 0003_identity.sql      employees + profiles (+ auth trigger, ancestry trigger)
    │   ├── 0004_rbac.sql          roles/permissions/role_permissions/role_assignments
    │   ├── 0005_functions.sql     app.has_perm + helpers + guards + get_my_access
    │   ├── 0006_modules.sql       leaves/expenses/attendance/tickets/assets (+ ancestry stamp)
    │   ├── 0007_rls.sql           RLS policies + grants for every table
    │   ├── 0008_seed_rbac.sql     seed the 7 roles + permission catalog
    │   ├── 0009_admin_rpcs.sql    list_managed_users + link_user_to_employee
    │   ├── 0010_modules2.sql      payslips/documents/jobs/candidates/onboarding/exits (+ RLS)
    │   ├── 0011_audit.sql         audit_log + triggers on the security-relevant tables
    │   ├── 0012_biotime.sql       BioTime ingest: devices, biotime_employees, raw_punches,
    │   │                          sync_state, sync_runs (+ code-linking functions)
    │   ├── 0013_attendance_engine.sql  shifts, shift assignments, holiday calendars, and
    │   │                          public.attendance extended into the engine's daily record
    │   ├── 0014_leave_regularization.sql  leave types/balances with LOP, regularizations,
    │   │                          and the triggers that queue an attendance recompute
    │   └── 0015_repair_attendance_fks.sql  idempotent: adds any attendance FK that a partial
    │                              0013/0014 run left out, then reloads the PostgREST cache
    └── functions/                 Edge Functions (deployed with the Supabase CLI)
        └── invite-user/           caller-authorized atomic login creation (optional)
```

## Setup order (run once)

1. Create a Supabase project; copy the **Project URL**, **anon** key, **service_role** key.
2. `cp .env.local.example .env.local` and fill `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`.
   (The web app uses `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` in `web/.env.local`.)
3. Apply the migrations in `supabase/migrations/` **in numeric order**. Two ways:
   - **Recommended (no CLI):** add `SUPABASE_DB_URL` to `.env.local` (dashboard → Connect →
     *Session pooler*, port 5432), then `npm install && npm run migrate`. The script applies
     each file once inside its own transaction and tracks progress in `_migrations.applied`,
     so it is safe to re-run. If the schema was already created by hand, run
     `npm run migrate -- --baseline` once to sync the tracker.
   - **Manual:** paste each file into the dashboard SQL Editor in order.
4. `python scripts/import_employees.py` to load the real staff.
5. `python scripts/create_user.py admin@parakkat.com --super-admin` to make the first admin.

> `npm run dev` here just prints these commands — the backend is hosted, so there is no local
> server to start. (It used to run `supabase start`, which this project doesn't use.)

### Retrying migration 0144 after a Storage ownership error

If `0144_immediate_account_revocation.sql` failed with `must be owner of table migrations`,
use the corrected file and run `npm run migrate` again from this directory. The original
policy scan included Storage's internal metadata tables. It now covers public HRMS tables
and `storage.objects`, where the application's document, asset, task and chat file policies live.
Storage metadata ownership and policies are left to the platform.

For this failure, 0144 rolled back before its commit. Files already reported `ok` (such as
0141–0143) stay applied and will be skipped; the runner retries 0144 and then continues with
0145 and 0146. Do not baseline the failed migration or change ownership of Storage's tables.

## Design notes

Password recovery and the latest user/role fixes have a dedicated
[audit and rollout checklist](USER_ACCOUNT_AUDIT.md), including migration `0120` and Supabase
redirect/email setup.

- **Security is in the database.** Every table has Row-Level Security; the single function
  `app.has_perm(perm, entity, zone, branch, dept, employee)` decides access. Scope inheritance is
  implicit because each row carries its full ancestry (entity/zone/branch/department ids).
- **Roles × Scope.** A role (e.g. `hr_manager`) is granted at a scope (branch=CDA), giving
  branch/department-level HR without extra roles.
- **Administration access.** Among standard roles, only Super Admin, Entity Admin and HR Manager
  hold `rbac.manage`. Apply `0148_administration_role_access.sql` through the normal migration runner
  to remove the earlier delegation from Zonal Manager, Branch Manager, Department Head and Employee.
  The database then refuses their account provisioning, password administration and role changes,
  as well as returning no managed users. HR and Entity Admin remain limited to their assigned scope
  and grant ceiling. Employee management and approvals keep their existing permissions; explicitly
  configured custom roles keep their own grants.
- **Module rows** carry `employee_id` + ancestry stamped by a trigger, so RLS filters without joins.
  Note: PostgREST embeds must disambiguate tables with two FKs to `employees` (e.g.
  `employee:employees!leaves_employee_id_fkey(...)` because of `employee_id` + `approver_id`).

## Local database verification

Run `npm test` in this directory with PostgreSQL tools (`initdb`, `pg_ctl`, `createdb`, `psql`)
on `PATH`. The runner creates its own temporary cluster and private UNIX socket, executes the
account-integrity, workflow, messaging, password-administration and standard-role suites, then removes the cluster. It never reads `.env` files or
connects to the hosted application. The workflow suite loads the real foundational migrations,
permission functions and RLS, then checks atomic shift replacement, rollback after a conflicting
date range, preservation of future assignments, branch/company restrictions, assignment-only roles
without access to personal employee data, and employee goal-progress restrictions.

Migration `0121_atomic_shift_assignment.sql` must be applied before the updated shift-assignment
form can save. It replaces the old sequence of browser writes with one transaction; a failed
replacement preserves the employee's current shift. Migration `0123_goal_progress_guard.sql`
prevents self-service users from rewriting a goal's definition or ancestry while allowing progress
updates. Apply pending files using the normal migration runner; these tests do not deploy them.

The standard-role suite replays every application migration against a minimal local Supabase SQL
platform shell (Auth identities, Storage tables and Supabase's API-role default grants). It uses
seven real standard role grants, including automatically added employee/self grants for managers,
plus linked-but-unassigned and anonymous controls. Five synthetic peers sit across department,
branch, zone and company boundaries; each actor also has their own employee record. Assertions
compare exact visible rows and mutation outputs for employees, attendance, leave, expenses, tasks,
goals, published/draft payslips and role administration. Successful trial writes are rolled back
individually. Shared-task tests verify that membership permits work updates without transferring
ownership. Migration `0124_role_revoke_visibility.sql` fixes scoped role revocation with returned
rows; `0125_task_assignment_guard.sql` protects task ownership and delegation fields.

Fresh replay also verifies the corrected `0119` view rebuild, which must drop the old view before
changing its column order. Historical migration `0062` expects an existing `GN` shift configured in
the deployed database: the disposable fixture inserts a synthetic `GN` shift immediately before
that migration. The test does not assert that an entirely empty production project can replay the
historical files without that prerequisite.

The runner exports actual grants to `../src/test/standardRolePermissions.json` and actual
`get_my_access()` payloads plus synthetic org IDs to `tests/fixtures/standard-role-access.json` for
the browser, rendered-component and attendance HTTP role tests. The matrix covers representative
standard scopes (global, entity, zone, branch, department and self); it does not exhaust arbitrary
custom/multiple role combinations or all legitimate HR scope variants. Hosted authentication,
PostgREST transport, Storage HTTP and Realtime are not started by these PostgreSQL tests. The
existing `0113` exception is tested explicitly: a linked login without a role may insert a personal
root task without requesting returned rows, while it remains unable to read or update that task.

Migration `0150_sync_run_history_performance.sql` fixes Sync runs statement timeouts by evaluating
the existing device-manager permission once per query and indexing history in its displayed
`started_at DESC, id DESC` order. It preserves exact totals, role scopes and immediate account
revocation. The standard-role suite loads 20,000 synthetic runs and checks actual query plans for
bounded ordered reads and a single permission evaluation, plus account-revocation and scope tests.

## Leave review and department ticket routing

Apply `0138_leave_approval_workflow.sql` and `0139_ticket_category_routing.sql` before deploying
the matching frontend. The normal migration runner applies pending files in order.

- Leave requests first go to an active, scoped Department Head with leave approval permission.
  Department approval forwards the request to HR; only HR/admin final sanction changes the leave
  balance. Missing heads and a department head's own request go directly to HR. No reviewer can
  approve their own request. Both stages require remarks and keep an immutable decision history.
- In **Helpdesk → Categories**, an organization administrator creates each category and chooses its
  receiving department. Mark categories intended for the **Tickets to HR** view with **HR queue**.
  Categories are offered across departments within the requester's company. Deactivation removes
  a category from new requests while preserving existing tickets and their original routing.
- Receiving department staff can read their queue with ticket read access. Its head or staff with
  ticket management permission can update status. HR's **All tickets** view respects their granted
  scope. Existing free-text tickets retain their original access rules.

`npm test` here verifies stage permissions, remarks/history, leave balances, attendance cancellation,
payroll locks, category routing, scope boundaries and revoked access in a disposable database.
For isolated UI checks, run `npm run qa:browser` in `web` and open
`http://127.0.0.1:5174/?qa-role=hr_manager&qa-workflow#/leave` or `#/helpdesk`; use the QA role picker
for Department Head, Employee and Entity Admin scenarios. These browser writes stay in memory.

## Named routines and completion history

Apply `0140_named_scheduled_routines.sql`, `0154_routine_edits.sql` and
`0156_routine_job_trash.sql` and `0157_routine_audit_notes.sql` before deploying the matching frontend. In
**Tasks → Routine**, managers create a named routine containing multiple jobs with one shared
schedule, then assign it to selected employees within their permission scope.

- Schedules use specific due dates: daily; selected weekly days (ISO Monday = 1, Sunday = 7);
  monthly on one day, clamped to the month's last day when needed; every N days from the start
  date; or once. Start/end dates bound the schedule. Home shows jobs due today.
- The bulk employee chooser filters by current designation/job title and permitted employees.
  Assignments apply to the selected people; later designation changes do not automatically add
  or remove assignments. Employee lists and team results are paginated.
- Employees complete today's jobs. Managers with scoped task-update access can correct earlier
  due dates. Future or non-due completions are rejected, and the server records the owner, actor
  and completion time.
- Use **Add jobs** on an assigned routine or checklist to extend it without creating a separate
  routine. Editing can take effect today or later, including a one-time routine due today.
  Upcoming routines are updated in place; established schedules retain an earlier version for
  history. The active management list shows only the latest version of each assignment.
- Admins open **Manage routines** by default. **Edit routine** remains available on the latest
  authorized assignment, including ended or retired routines under **Archived**. Saving an ended
  routine resumes it from the selected date. In Employee view, **Switch to admin view** restores
  the management controls. Super Admin has global routine access; Entity Admin keeps its granted
  organizational scope. Older, replaced schedules remain historical records.
- To undo retirement, choose **Manage routines → Schedule status: Retired → Restore routine**.
  The Retired filter includes routines retired today and only their latest version. Choose a
  **Restore from** date and optional end date, then confirm **Restore routine**. It returns to
  Active and upcoming with the same employee, active jobs and recurrence. Earlier completions
  remain recorded, and the retirement gap is not counted as missed work. Deleted jobs remain
  separately recoverable in the editor. Interval schedules suggest the next original due date;
  selecting another restore date restarts their interval. Restoration uses the existing routine
  edit RPC and requires the same management permission.
- Existing job IDs accompany edits so today's completed jobs keep their original completion
  record, actor and time. Adding or reordering jobs is allowed today. Removing or changing a job
  already completed today requires a future effective date. Moving an upcoming replacement
  cannot erase completions on its predecessor. Retirement ends future occurrences after today.
  Historical completion rates retain the schedule and job counts that applied on those dates.
- In the routine editor, **Delete** moves a saved job to **Deleted jobs**. **Restore job** adds it
  back; **Save** commits either change. Deleted jobs remain available across schedule versions,
  while earlier completion history stays unchanged. A routine must retain at least one active
  job; use **Retire** to stop the whole routine. Restoring jobs on an archived routine resumes it
  from the selected effective date. Jobs physically removed before this migration cannot be
  recovered through this feature.
- Home shows each employee's **Not started**, **In progress**, or **Completed** status, combining
  all routines due today. Heads and higher roles see only their permitted team, with unfinished
  employees first and a link to the full daily checklist. Existing realtime updates refresh the
  dashboard after ticks and reopened jobs. These status updates do not send notifications.
- Employees use **Add note** under a routine's daily checklist to explain incomplete or partial
  work. Notes apply to that routine and selected due date, including weekly/monthly routines;
  they do not mark jobs complete. Employees may add notes for their own due dates today or in
  the past. The actual saved time remains visible, so a later explanation does not look like an
  earlier submission. Future dates, non-due dates and notes on behalf of another employee are
  refused by the database.
- Notes preserve the employee's name, routine title, server timestamp and completed/total count
  at submission, plus an internal job snapshot. Saved notes cannot be edited or deleted through
  the app; corrections are additional notes. Request IDs make uncertain network retries safe.
  **Notes history** filters by routine date (up to 366 days) and searches employees, routines or
  explanations. Employees see their own records; heads and admins see their permitted scope.
  Notes remain available after routine edits, retirement or restoration, including schedule
  changes that remove a date from the daily checklist. Realtime refreshes both note views without
  changing completion counts or sending notifications.
- Legacy routine history has no reliable activation/retirement dates. Expected and missed-job
  rates therefore start at rollout; earlier recorded completions remain visible as unscored
  history. Invalid legacy owner/future ticks are retained privately for audit.

From `web`, run `npm test --prefix backend` for isolated SQL upgrade, recurrence, permissions and
history checks. For browser checks, run `npm run qa:browser` and open
`http://127.0.0.1:5174/?qa-role=dept_head&qa-routines#/tasks/routine` or
`http://127.0.0.1:5174/?qa-role=employee&qa-routines#/dashboard`.
The QA role picker supports manager/admin comparisons; fixture writes stay in memory. The routine
fixture also supports employee note creation and scoped **Notes history** review. SQL tests cover
immutable evidence, retry idempotency, scope changes and concurrent note/tick writes.

## Task deletion and recovery

Apply `0155_recoverable_tasks.sql` before deploying the matching frontend; apply all pending
migrations in order. **Delete** moves a task and its active subtasks into **Tasks → Deleted tasks**.
**Restore task** restores that deletion batch with its original status, dates, comments, files,
assignees and checklist progress. Subtasks deleted separately stay deleted, and a deleted parent
must be restored before a separately deleted child. Restored older completed tasks return to the
board's recent-history window without changing their original completion date.

Deletion and restoration require the existing scoped task-management permission for every
affected task, or ownership of a self-created, self-assigned personal root task. Deleted tasks
leave operational lists, queue counts and task reminders; editing their content is blocked.
Records stay available for restoration with no automatic purge. Realtime updates refresh both
active and deleted lists. Direct permanent deletion by authenticated clients is disabled, and
the frontend never falls back to permanent deletion if the recovery migration is missing.
Previously permanently deleted tasks need a backup; this migration cannot recreate them.

The backend suite covers permissions, batch recovery, child tasks, content protection, counters,
notifications and concurrent writes. For an isolated browser check, run `npm run qa:browser`
in `web` and open
`http://127.0.0.1:5174/?qa-role=dept_head&qa-task-trash&qa-routines#/tasks/board`.
All fixture changes stay in memory.

## Navigation section counts

Apply `0151_navigation_counts.sql` before deploying the current navigation client. Its
`get_navigation_counts(_self_only boolean default false)` RPC includes the original five queues
plus incoming task requests, unfinished routine jobs due today in IST, personal and managed active
goals, draft payroll runs, incomplete onboarding checklists, active hiring candidates, outstanding
exit clearances, unlinked device employees and the full unread notification count. All values use
the caller's permissions; employee view retains personal work and suppresses management queues.
Parent menus sum distinct queues and their submenus use the corresponding count. Reports and
configuration screens without an actionable queue have no badge. Missing counts remain unknown.

The client uses a versioned cache so an old five-key response cannot become an understated total.
Queue mutations, batched Realtime changes and the visible-only minute refresh update parent and
child badges together. The notification preview remains limited to forty rows, but its badge and
the Notifications menu count the whole unread inbox. `tests/navigation_counts.sql` verifies the
new envelope, per-role scope, completion transitions, inactive callers and more than 1,000 unread
notifications in the isolated database test runner. The original RPC below remains available for
older clients.

Apply `0141_section_counts.sql` **before deploying the client that displays section badges**.
The authenticated `get_section_counts(_self_only boolean default false)` RPC returns only five
integer counts: `tasks`, `leave`, `expense`, `attendance`, and `helpdesk`. Identity and scope come
from the verified caller; inactive, banned, deleted and anonymous accounts are refused.

Tasks count unfinished primary/secondary assignments once each, including old open work. Leave
counts current department/HR reviews, including holds and excluding payroll-locked requests.
Expense and attendance count pending approvals in scope, excluding the caller's own requests;
expenses also exclude claims filed by the caller. Support counts manageable Open, In Progress,
and On Hold tickets using the receiving-department/HR rules, including legacy ticket scope.
Reading a ticket or raising one does not by itself add it to the support-action badge.
Employee view (`_self_only=true`) retains assigned tasks and suppresses management queues.

The client caches counts for one minute, invalidates on batched Realtime changes, and has a
visible-only 60-second fallback. The migration publishes `task_assignees` so membership changes
can also refresh task badges. No count is limited to a displayed page or recent-history window.
`npm test --prefix web/backend` replays the migration twice and tests authorization, department
routing, status transitions, ownership exclusions and summaries larger than a list page in a
disposable database.

## Administrator password reset

Apply `0131_admin_password_reset.sql` before using the temporary-password action in Administration.
Apply `0132_allow_names_in_passwords.sql` to allow names, usernames and email addresses in passwords.
The authenticated RPC `admin_set_user_password(_user_id uuid, _password text)` returns `void`.
It permits super admins, or an `rbac.manage` holder whose scope includes the employee and whose
rank exceeds the target's. Unlinked logins require a super admin. Self-service password changes
continue through Supabase Auth; the administrator RPC refuses the caller's own account.

A successful reset installs a bcrypt temporary password, sets `profiles.must_change_password`,
clears pending authentication tokens and deletes the target's refresh tokens and sessions in one
transaction. It preserves the account's email, employee link, roles, metadata, MFA factors,
confirmation and ban status. It sends no email. `audit_log` records `PASSWORD_RESET` with actor,
target and organization scope, without storing the password or hash. Existing access JWTs remain
valid until their normal expiry, as with Supabase sign-out.

This follows the existing SQL Auth integration used by `admin_create_user`; it depends on the
hosted Auth tables (`auth.users`, `auth.identities`, `auth.sessions`, `auth.refresh_tokens` and
`auth.one_time_tokens`). Its token cleanup mirrors
[Supabase Auth's password update implementation](https://github.com/supabase/auth/blob/master/internal/models/user.go).
Only existing email identities are eligible. Passwords require at least eight characters, cannot
contain only numbers, and cannot exceed bcrypt's 72 UTF-8 bytes. Names, usernames and email
addresses are allowed.
The password-administration suite replays every migration, repeats `0131` and `0132` to check safe reruns,
and exercises these rules and RBAC boundaries using synthetic identities. It checks stored
bcrypt compatibility and SQL behavior; it does not run a hosted Auth sign-in or send a recovery email.

## Chat preferences, search and typing

Migrations `0133_chat_preferences.sql` and `0134_chat_typing.sql` support the updated Messages
screen. Pins and favourites belong to the signed-in employee and persist across devices; an
administrator monitoring a conversation cannot view or change someone else's preferences.
`search_chat_messages` searches the authorized conversation's full, non-deleted history with
literal text matching and timestamp/ID pagination. It uses the same read permissions as the thread.

Typing shares only a boolean and server timestamps through `set_chat_typing`. Both writes and
Realtime reads require membership in an accepted conversation. Updates are throttled, expire
after six seconds, and clear on send or loss of focus. Draft text is never transmitted by this
feature. The SQL test runner covers preference isolation, full-history search and typing access;
frontend tests cover pagination and the typing publisher's lifecycle. The optional `?qa-chat`
browser fixture exercises these controls entirely in memory.

## Developer Settings and integration API keys

Super admins can enable the read-only integration API and create scoped, expiring keys in
Administration → Developer Settings. Keys can be restricted to one company and revoked immediately.
Migration `0135_developer_api_keys.sql` stores only key hashes and enforces all API access in SQL;
the Vercel function exposes employee directory, organization and daily attendance endpoints.
See [Developer API](DEVELOPER_API.md) for deployment, request examples and access controls.
