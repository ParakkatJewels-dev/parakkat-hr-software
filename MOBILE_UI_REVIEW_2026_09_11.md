# Mobile UI fixes — 11 September 2026

The task, routine, pagination/theme, punch timeline and chat work was split across agents,
then integrated and checked in Chrome using the production React components with isolated
synthetic data. No live employee records, messages, photos or hosted database rows were changed.

## Changes and observed outputs

| Request | Result and validation |
| --- | --- |
| Compact My Tasks | Reduced phone heading/form/progress spacing; optional priority/date controls and status help stay available through disclosures. At 320px, the first long task title starts at about 397px instead of 611px, uses 13.5px text and does not overflow. Home shows a compact preview with the full open-task count and 44px completion targets. |
| Daily Home routine | Own active duties appear after the employee hero and above the manager dashboard. The 2-duty fixture changes from 0/2 to 1/2 and disappears after the second successful save. Archived and other employees' duties stay hidden. A failed save keeps both duties visible with an error. Automated tests cover the next IST day and waking a suspended tab. |
| Phone theme toggle | Header toggle stays visible at 320px with a 44×44px target. Both header and Settings switches change the actual theme; the Settings switch has a separate 48×44px target and fixed track geometry. |
| Compact pagination | One 54px footer with 44px first/previous/next/last controls. The centre disclosure shows counts and page size. In the 525-person fixture, next page shows employees 13–24, last page 517–525, and choosing 120 rows resets to 1–120 of 525. The floating directory filter hides while options are open so it cannot cover the selector. |
| Punch detail overlap | Label packing measures the available panel width and accounts for 12-hour text and edge alignment. At 320px and 390px, all 8 punch times and 7 durations are present with zero intersecting bounds or labels outside the bar. The example independently totals 475 worked minutes and 79 break minutes across 3 breaks. In/out header values wrap safely. |
| Chat/group settings | Both use Chat settings → details → Back to chat. Direct chat shows employee identity without name/photo inputs. Groups have name/photo editors and paged member management. A blocked group rename shows an error and keeps the original identity. Both settings screens fit at 320px. Lost save responses are confirmed before upload cleanup, preventing deletion of an already-saved photo. |

## Automated verification

`npm run verify` passed. After the final group-photo error-handling correction, the frontend
test, lint and build checks were rerun successfully:

- 686 frontend tests and 211 service tests.
- 1,163 real PostgreSQL assertions after replaying 131 migration files, covering seven standard
  roles, unassigned users and anonymous access. This includes 112 new chat identity/storage checks.
- 249 local HTTP role requests, 8 real attendance-engine integration tests and SQL/XLSX report
  output checks using 503 synthetic employees.
- Frontend lint/build and service typecheck/build. Existing lint warnings remain.

The punch layout also passed an independent review with 1,000 deterministic clustered-label
cases from 220px to 900px and explicit odd-punch output checks.

The final 320px Chrome sweep passed all 45 routes plus the keyboard skip-link check for each of
Super Admin, Entity Admin, HR Manager, Zonal Manager, Branch Manager, Department Head and Employee.
The unassigned account was correctly blocked from entering the app: **323 browser checks passed,
zero failed**. Each sweep checked expected scoped counts and denials as well as rendering and
horizontal overflow. Detailed interactive checks above additionally used 390px where indicated.
The summary is recorded in `web/qa/mobile-role-results-2026-09-11.json`.

## Reproducing browser checks

Run `npm run qa:browser` in `web/`, then open `http://127.0.0.1:5174`.
The visible QA panel selects roles and runs 45 screen checks, scoped expected totals, access
denials and the keyboard skip-link check. `?qa-role=employee&qa-mobile=1` enables rich punch,
long-task, routine, group and direct-message fixtures. Only own routine tick mutations save in
memory in this explicit mode; other writes are blocked. Adding `&qa-block-write=1` exercises
routine save errors. Reload resets in-memory fixture mutations.

The adapter verifies UI behavior, not backend security. Database and HTTP suites verify their
respective permission boundaries separately. Fixture timings are not production latency or a
500-concurrent-user load benchmark.

## Rollout

Apply `0128_group_chat_identity.sql` before releasing group picture editing. It adds the private
photo path to conversation summaries and restricts authenticated identity updates to group
members changing group name/photo. Direct identity, conversation kind and creator are protected.
It uses the existing private `chat-media` bucket and membership policies.

The attendance service fixes also require migrations 0126 and 0127 before the updated worker is
restarted; see `SERVICE_BUG_REVIEW_2026_09_11.md`. These migrations have been tested locally and
have not been deployed by this task.
