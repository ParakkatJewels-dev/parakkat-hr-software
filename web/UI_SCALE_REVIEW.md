# Users & Access and list-scale review

## Implemented

| Area | Change |
| --- | --- |
| Users & Access | Compact expandable account directory; 25 accounts per page; 10/25/50/100 sizes; direct page jump; company, branch, role and account-status filters; multiword search; sorting; missing-role and unlinked-account counts. Advanced filters collapse on phones. Existing access checks, confirmations and password-reset actions are retained. |
| App-access and employee linking | Searchable, paginated employee selection replaces the long app-access dropdown and silently truncated linking results. |
| Shared pagination | Keeps smaller sizes reachable after increasing page size, clamps deleted/filtered pages, resets on filter changes, and permits navigating away from a notification's focused row. Narrow panels use container-responsive controls. |
| Directory | Keeps paging controls after increasing page size, clamps the last page after removals, and correctly offers the phone's 12-row size. |
| Attendance, tasks, assets, documents, leave, expenses, goals | Existing pagers now reset with their relevant filters. Leave, expense and ticket activity loads every matching row in its existing 180-day window instead of stopping at 500. Task status behavior and message styling are unchanged by this work. |
| Attendance employee pickers | Person searches and device-mapping searches no longer silently stop at 8 or 5 matches. Device matching also searches employee codes. |
| Hiring and onboarding | Search, company filtering for hiring, independent candidate-column paging, paginated openings and hires, and visible mutation errors. |
| Payroll | Month-scoped payslips with search and paging; searchable/paged run history and current salaries; loading/error states distinguish failures from empty lists. The 36-run history ceiling is removed. |
| Organisation | Structural tables page independently and reset when switching company; paging is disabled during an inline edit. |
| Reports | Tables show 25 rows per page. Totals and exports still use all matching records. Period-bounded leave/expense data loads across API response pages. |
| Support, personal assets, notifications | Paged exits, assigned assets and recent notifications. Personal asset photos are requested only for the visible page. |
| Audit log | Server-side search, exact counts and 25/50/100-row paging replace the latest-100-only list. RLS remains in force. |
| Roster/reference loading | Employees, matching device employees, onboarding, hiring, salary structures and payroll runs load in deterministic batches, with errors instead of partial success if a batch fails or repeats. |

## Verification

- Production build passes; 556 automated tests pass.
- Synthetic fixture: 675 accounts, split equally across three companies. Tests verify each account remains reachable once at every offered page size, company/role/branch/search behavior, 25 mounted account panels, and preserved permission-sensitive actions.
- Rendering tests cover 675 hires, 700 candidates, 50 openings, 675 report rows, 675 monthly payslips and 675 salaries.
- Fetch tests cover 1,275 roster rows with a simulated 97-row server response cap, failed/repeated batches, and audit page 7 of a 2,500-entry result.
- Local browser checks: desktop light theme and a 390px dark-theme preview; last-page navigation, company/branch reset, employee-code search, account expansion, empty results, size changes, page jumps and app-access employee search. Desktop overflow check passed; the phone layout was visually inspected. Synthetic data only; no live mutations or emails.
- Existing fast-refresh lint warnings and Vite test HMR-port warnings remain; they do not fail the build or tests.

## Boundaries and remaining work

This was a UI/list-scale pass, not a production load test or a complete business-rule/security audit. Existing query scopes and permissions were preserved. No database migration is required by these changes.

Operational leave, expense and helpdesk feeds retain their existing 180-day activity windows (now fetched across response pages); they are not full-history browsers. Notifications remain the latest 40, now labelled explicitly. Dashboard/self-history payslip callers retain their existing bounds. Period-specific reports and the audit log have separate retrieval paths. Moving remaining activity feeds to full-history server pagination is follow-up work if older operational history needs to be browsed directly.

Team/member and request lists already had pagination. Settings/profile forms, calendars, aggregate dashboard widgets and small role/permission catalogues do not grow one row per employee. Messaging and Chat Monitor changes present elsewhere in the workspace were not part of this implementation.

Production Supabase RLS behavior, email delivery and performance against real multi-company data still require staging verification. Unit query tests do not replace that check.
