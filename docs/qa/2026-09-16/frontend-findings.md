# Frontend QA findings — 16 September 2026

This audit found **7 reproducible frontend defects, 1 confirmed visible workflow gap, and 1 item requiring business clarification**. No application fixes, production mutations, real messages, or real user creation were performed by this audit. Existing uncommitted changes were preserved. Browser work and database testing are reported separately by the other QA agents.

## Executed checks

| Check | Result | Boundary |
| --- | --- | --- |
| `cd web && npm test` | **1,101 passed; 0 failed; 0 skipped**, 17.47 seconds | 102 test files; includes pure functions, source/query assertions, synthetic React rendering, and selected real handlers with stubbed network boundaries. Not 1,101 browser end-to-end workflows. |
| `cd web && npm run lint` | Exit 0; **32 warnings** | Warnings are mostly Fast Refresh exports plus unused variables, unnecessary escapes and one hook-dependency warning. |
| `cd web && npm run build` | Exit 0; **2,684 modules transformed** | Production bundle compiled. Does not validate a deployed service or device. |
| `cd web && node qa/frontend-audit-2026-09-16.mjs` | **10 reproduction cases observed** | Real React components rendered with isolated synthetic query caches. Covers eight finding IDs, including FE-04 clarification and FE-09 workflow gap. |
| `cd web && node qa/recruitment-form-audit-2026-09-16.mjs` | **2 handler checks observed** | Real recruitment event handlers confirm supported Reject action and FE-08 invalid-title write payload. No database persistence. |

Some existing test workers logged `WebSocket server error: Port 24678 is already in use`. Tests still completed with all assertions passing; this is test-harness noise, not a demonstrated user-facing failure. The added audit scripts explicitly assert current faulty observations; a successful audit-script exit means the defect reproduced, **not** that the application passed that scenario.

Evidence: [rendering observations](frontend-reproductions.json), [recruitment handlers](recruitment-form-reproductions.json), [control/coverage inventory](frontend-coverage.md). Reproduction scripts are [frontend audit](../../../web/qa/frontend-audit-2026-09-16.mjs) and [recruitment audit](../../../web/qa/recruitment-form-audit-2026-09-16.mjs). Source paths below are repository-relative.

## Confirmed defects

### FE-01 — Failed reports claim there is no data and allow empty CSV export

- **Priority:** P1 — misleading operational output during a backend/network failure.
- **Affected viewers:** Any role allowed to use Reports; reproduced with a synthetic super-admin account.
- **Reproduce:** Open Reports → Leave with `leaves-period` failed and no cached data; repeat for Expenses with `expenses-period` failed and Headcount with `employees` failed.
- **Expected:** Identify the failed query, offer retry, and prevent exporting an unverified empty report.
- **Actual:** All three screens render “No data for this period in your scope.” No query error appears and CSV controls remain enabled. Attendance already has separate error handling, so this is not universal to the report module.
- **Cause:** `ReportsAnalytics.jsx:155`, `:156`, `:157`, `:185`, `:201` destructure only `data`, defaulting failed reads to empty arrays. The employee query at `:113` similarly discards its error. `ReportTable` turns `[]` into a successful-empty message.
- **Evidence:** [leave](FE-01-leave.html), [expenses](FE-01-expenses.html), [headcount](FE-01-headcount.html).
- **Scope:** SSR output and enabled-export state confirmed; downloaded files and failure-to-recovery browser interaction were not exercised here.

### FE-02 — Monthly approved-leave days include days outside the selected month

- **Priority:** P2 — inaccurate period subtotal; does not establish a payroll calculation error.
- **Affected viewers:** Reports users.
- **Reproduce:** Supply an approved three-day leave from 31 August through 2 September 2026. Open September → Leave.
- **Expected:** Two approved days belong to September. An explicitly request-total metric could show three, but it should not be presented as September approved days.
- **Actual:** “Approved Days” shows **3**. The same complete request contributes to both overlapping months.
- **Cause:** `ReportsAnalytics.jsx:158` correctly selects overlapping requests, but `:167` sums entire `l.days`, without restricting the counted dates to the period. The fallback “Other” group uses the same whole-request sum. `data/leaves.js:39` returns date bounds and whole-request days for this report.
- **Evidence:** [rendered September result](FE-02.html), `frontend-reproductions.json` entry FE-02.
- **Fix-review note:** Decide how half-days, holiday rules and cancelled dates are apportioned; do not simply divide a request total evenly over calendar days.

### FE-03 — Headcount combines separate companies' branches when their codes match

- **Priority:** P2 — wrong branch-level reporting and export grouping.
- **Affected viewers:** Users who can see more than one company, typically super admins or accounts with multiple grants.
- **Reproduce:** Two distinct companies each have a branch with code `HQ`, different branch IDs, and one active employee. Open Reports → Headcount → All branches.
- **Expected:** Two distinguishable branch rows, each with one active employee.
- **Actual:** A single `HQ` row shows **2** active employees. Exit counts use the same ambiguous branch-code lookup.
- **Cause:** `ReportsAnalytics.jsx:205-206` groups by `code`; `:215` attaches exits by `code`. The schema explicitly permits repeated branch codes across companies: `web/backend/supabase/migrations/0002_org.sql:39` is `unique(entity_id, code)`.
- **Evidence:** [rendered merged headcount](FE-03.html).

### FE-05 — Reject hides a candidate while the hiring screen still counts that candidate

- **Priority:** P2 — candidate history becomes inaccessible through the hiring UI and counts disagree with visible results.
- **Affected viewers:** Recruitment managers (normally super admin, entity admin, HR manager).
- **Reproduce:** From an Applied candidate, use the visible Reject action. After the mutation/refetch, the row has `stage: 'Rejected'`.
- **Expected:** Rejected candidates remain accessible through a filter, archive or stage; matching-profile count describes reachable results.
- **Actual:** With one rejected candidate, the screen says **1 matching profiles** and **Candidates 1**, but all four stages say **No applicants**. The candidate's name is absent.
- **Supported workflow confirmed:** The real `Recruitment.jsx` Reject handler emits `{id:'candidate', stage:'Rejected'}`; this is not an invented database stage. `0010_modules2.sql:99` also documents Hired/Rejected as stages.
- **Cause:** `Recruitment.jsx:11` defines only Applied, Shortlisted, Interview, Offered; `:29` and `:41` count the entire result set, while `:98-99` renders only those four stages.
- **Evidence:** [rendered inaccessible candidate](FE-05.html), [actual Reject handler observation](recruitment-form-reproductions.json).
- **Scope:** Mutation payload and post-mutation-equivalent rendered state confirmed; no production candidate was rejected.

### FE-06 — Hiring errors still present zero counts and empty pipeline as facts

- **Priority:** P2 — misleading failed-read presentation.
- **Reproduce:** Open Hiring with both jobs and candidate reads failed and no cached results.
- **Expected:** Unavailable metrics and pipeline, with errors and retry; no claim that hiring has zero records.
- **Actual:** The error text appears, but so do Open roles **0**, Candidates **0**, **0 matching profiles**, and four **No applicants** messages.
- **Cause:** `Recruitment.jsx:15-16` defaults failures to arrays; `:32-45` renders calculated zero KPIs unconditionally; pipeline rendering only distinguishes loading from other states.
- **Evidence:** [rendered failure state](FE-06.html).

### FE-07 — Failed separation read hides existing-request uncertainty and offers Request Exit

- **Priority:** P2 — incorrect empty-state output and possible duplicate-request entry path.
- **Affected viewers:** Linked users allowed to request separation, including employees.
- **Reproduce:** Open Helpdesk & Separation with `exits` failed and no cached data, using a linked employee account with exit-create permission.
- **Expected:** Visible unavailable state; determine whether an open request exists before offering a new request.
- **Actual:** “No exit records visible to you.” appears with a **Request Exit** button; the query error is omitted.
- **Cause:** `HelpdeskExit.jsx:20` discards error/loading. `:32-34` searches an artificial empty array, and `:65` interprets the lack of an open result as permission to create a new request.
- **Evidence:** [rendered failure state](FE-07.html).
- **Scope:** Misleading state and exposed creation entry point confirmed. Duplicate database records were not created by this audit.

### FE-08 — Publish Opening accepts a whitespace-only job title

- **Priority:** P2 — required-field validation failure.
- **Reproduce:** Hiring → Publish Opening → choose a company → enter three spaces in Job Title → Publish.
- **Expected:** Reject the blank title before mutation and retain the form with a validation message.
- **Actual:** Real submit handler invokes the mutation once with `title: '   '` and closes the form after the stubbed successful response.
- **Cause:** `Recruitment.jsx:49` tests truthiness instead of `.trim()` and `:51` sends the untrimmed value. Native `required` on a text input does not treat spaces as empty.
- **Evidence:** [captured write payload](recruitment-form-reproductions.json).
- **Scope:** Frontend handler/write payload confirmed; backend persistence not tested here. The original jobs schema uses only `title text not null`, but this report does not assume deployed constraints from that alone.

## Confirmed visible workflow gap

### FE-09 — HR can view separation clearances but cannot act on them

- **Priority:** P1 if exit clearance is intended to be completed within this HRMS; otherwise an explicitly missing management workflow.
- **Reproduce:** Render Helpdesk & Separation as HR manager with the standard permission fixture and entity scope. Supply one visible employee exit in `Clearance in Progress`, with IT, Admin, Finance and HR all Pending.
- **Expected:** An authorized exit manager can record permitted clearances and progress/complete the exit, or the UI identifies the external workflow responsible for doing so.
- **Actual:** Employee and all four Pending statuses appear, but the entire Exit Clearances section contains **no buttons, inputs, selects or textareas**. The HR user has `exit.manage`.
- **Source corroboration:** `HelpdeskExit.jsx:13` instantiates only `useAddExit`; the four clearance cells are display-only. `web/src/data/exits.js` exports only read and insert hooks, with no update/clearance mutation. The database has an `exits_update` policy for `exit.manage`, so database authority exists but there is no matching frontend workflow.
- **Evidence:** [HR manager with pending exit](FE-09.html), `frontend-reproductions.json` entry FE-09.
- **Scope:** Missing visible controls confirmed with a populated real component. This audit does not assume an external clearance system is absent; that integration was not specified or tested.

## Business clarification, not counted as a confirmed defect

### FE-04 — Meaning of Active in a selected-month headcount report

- **Observed:** A synthetic Active employee with join date 1 January 2099 contributes **1** to Active in the September 2026 Headcount & Movement report.
- **Source:** `ReportsAnalytics.jsx:207` uses current employee status only; join date and report period only affect Joiners.
- **Clarification:** Should Active be headcount as of selected month end, or today's roster shown next to historical movement? The former requires historical date/status handling; the latter needs an explicit current-roster label. No requirement was supplied that selects one interpretation.
- **Evidence:** [rendered future joiner](FE-04.html).

## Limits and review order

Prioritize FE-01, then FE-02/FE-03 output correctness, then FE-05/FE-07 workflow reliability and FE-06/FE-08 presentation/validation. All remain unfixed, as requested. This frontend audit does not certify every option, production authorization, hardware punches, real account recovery delivery, real file downloads, persistence, or simultaneous users. The [coverage inventory](frontend-coverage.md) distinguishes tested evidence from remaining end-to-end work.
