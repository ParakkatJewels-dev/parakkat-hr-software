# HRMS bug register — 16 September 2026

**Original audit: 21 confirmed defects, 1 confirmed workflow gap, and 4 policy/meaning questions. All confirmed defects and the workflow gap are now fixed locally; policy choices are resolved.** See the [fix status and verification](fixes/README.md). The table below preserves the original pre-fix observations. Findings concern the current local source, including existing uncommitted changes; they do not establish which migrations are deployed remotely. Tests used synthetic identities and records only.

High = incorrect pay, approval/identity bypass, or materially misleading operational output. Medium = reporting, validation or workflow reliability issue. Priorities record the original review order; the user subsequently authorized the fixes.

## Confirmed defects

| ID | Priority | Feature / persona | Expected output | Reproduced actual output | Detailed reproduction |
| --- | --- | --- | --- | --- | --- |
| PAY-04 | High | Publish payroll → employee payslips | Employee can read the published payslip and earning lines | Run becomes Published, payslip becomes Paid, and employee RLS returns **0 payslips / 0 lines** | [Payroll](payroll-findings.md#pay-04) |
| PAY-01 | High | Payroll / HR manager | One absent day + one half-day reduce ₹30,000 salary to ₹28,500 | **₹30,000 and 30 payable days**, rather than ₹28,500 and 28.5 days | [Payroll](payroll-findings.md#pay-01) |
| PAY-02 | High | Payroll deduction proration / HR | ₹3,000 fixed deduction configured to reduce with 15 unpaid days becomes ₹1,500 | Deduction remains **₹3,000**; net ₹12,000 instead of ₹13,500 | [Payroll](payroll-findings.md#pay-02) |
| PAY-03 | High | Salary structure and allowances / HR | Allowance described as part of gross preserves agreed ₹30,000 gross | Named salary parts plus allowance produce **₹35,000 gross** | [Payroll](payroll-findings.md#pay-03) |
| DB-01 | High | Expense submission / employee | New claim requires independent approval | Direct authenticated inserts accept **Approved and Paid** starting states | [Database](database-role-findings.md#db-01--high-employees-can-submit-expenses-already-approved-or-paid) |
| DB-02 | High | Attendance correction / employee | New correction starts Pending | Direct authenticated insert accepts **Approved**, without a reviewer | [Database](database-role-findings.md#db-02--high-employees-can-insert-an-already-approved-attendance-correction) |
| DB-03 | High | Expense filer identity / employee and manager | Server controls the filer; filer cannot approve their submission | Employee forges another filer's identity; manager clears `created_by` while approving their filed claim | [Database](database-role-findings.md#db-03--high-expense-filer-identity-is-writable-and-the-filer-approval-rule-can-be-bypassed) |
| DB-04 | High | Expense decision / branch manager | Manager cannot approve/pay their own claim | **Pending → Paid** and **Pending → Draft → Approved** bypass the guard | [Database](database-role-findings.md#db-04--high-changing-expense-states-bypasses-the-self-approval-guard) |
| DB-05 | High | Separation / employee | Clearances require authorized decisions | Employee inserts **Completed** with IT, Admin, Finance and HR already Approved | [Database](database-role-findings.md#db-05--high-employees-can-create-an-exit-record-with-all-clearances-already-approved) |
| ATT-01 | High | Missing arrival correction / employee + HR | Approved 09:00 arrival preserves actual 16:30 departure; 450 minutes | Departure disappears; **510 minutes, Missing Punch, 0.5 payable day** in the tested exception-policy shift | [Attendance](attendance-findings.md#att-01--high-approved-missing-check-in-discards-the-actual-departure) |
| ATT-02 | High | Missing departure correction / employee + HR | Corrected timeline retains 90-minute break; 460 credited minutes | **510 minutes, 0 break minutes**, unresolved missing-punch flag | [Attendance](attendance-findings.md#att-02--high-approving-a-missing-departure-fails-to-rebuild-break-accounting) |
| ATT-05 | High | Overnight correction / employee | 22:00–06:00 departure belongs to the following date | Mutation puts both times on the same date, violating the database time-order constraint | [Attendance](attendance-findings.md#att-05--high-the-correction-form-cannot-represent-a-shift-crossing-midnight) |
| FE-01 | High | Leave, expense and headcount reports | Failed loading is visible; unverified empty export is blocked | Shows **“No data”** and enables CSV export during failed reads | [Frontend](frontend-findings.md#fe-01--failed-reports-claim-there-is-no-data-and-allow-empty-csv-export) |
| DB-06 | Medium | Expense validation / employee | Negative reimbursement claim is rejected | Own claim with **amount -100** is stored | [Database](database-role-findings.md#db-06--medium-negative-expense-claims-are-accepted-by-the-database) |
| ATT-03 | Medium | Rest-day correction | Approved complete timeline clears the missing-punch flag | 120 minutes credited, but **missing-punch flag and contradictory remarks remain** | [Attendance](attendance-findings.md#att-03--medium-a-completed-correction-on-a-rest-day-retains-an-incorrect-missing-punch-exception) |
| FE-02 | Medium | Monthly leave report | Aug 31–Sep 2 contributes 2 September calendar days in this full-day example | September **Approved Days = 3** | [Frontend](frontend-findings.md#fe-02--monthly-approved-leave-days-include-days-outside-the-selected-month) |
| FE-03 | Medium | Multi-company headcount | Distinct company branches with code HQ remain separate | Two branch IDs merge into **one HQ row with 2 employees** | [Frontend](frontend-findings.md#fe-03--headcount-combines-separate-companies-branches-when-their-codes-match) |
| FE-05 | Medium | Recruitment / HR | Rejected candidate remains reachable in history/filter/archive | Reject action hides candidate from every stage while counts still include it | [Frontend](frontend-findings.md#fe-05--reject-hides-a-candidate-while-the-hiring-screen-still-counts-that-candidate) |
| FE-06 | Medium | Recruitment failed reads | Counts and pipeline are shown as unavailable | Alongside the error, UI asserts **0 roles / 0 candidates / No applicants** | [Frontend](frontend-findings.md#fe-06--hiring-errors-still-present-zero-counts-and-empty-pipeline-as-facts) |
| FE-07 | Medium | Separation failed read / employee | Determine whether an existing request exists before offering another | Error is hidden; **No exit records** and **Request Exit** are shown | [Frontend](frontend-findings.md#fe-07--failed-separation-read-hides-existing-request-uncertainty-and-offers-request-exit) |
| FE-08 | Medium | Publish job / HR | Whitespace-only required title is rejected | Actual handler submits **three spaces** and closes the form after simulated success | [Frontend](frontend-findings.md#fe-08--publish-opening-accepts-a-whitespace-only-job-title) |

Counts: **13 High + 8 Medium = 21 distinct defects**. Multiple failing assertions may represent one defect. FE-01 was independently reproduced in a real browser and is counted once.

## Confirmed workflow gap

**FE-09 — Separation clearance:** a standard HR Manager with `exit.manage` sees a populated pending clearance record but has **no controls to approve a department, change status or complete the exit**. The data layer has read/insert hooks only. Treat as High if clearance must be completed inside this HRMS; otherwise document the external workflow. [Evidence and scope](frontend-findings.md#fe-09--hr-can-view-separation-clearances-but-cannot-act-on-them).

## Policy observations from the original audit

These observations are **not included in the confirmed-defect count**. The user has now chosen immediate inactive/banned blocking, current-roster headcount with a clear label, and provisional half-day credit until verified. The original questions follow:

1. **Inactive employees:** should an already authenticated HR user lose access immediately when their employee status becomes Inactive? Local RLS still returns 4 peer records.
2. **Banned accounts:** should an already issued identity/token lose access immediately after `banned_until` is set? Local RLS still returns 4 peer records; fresh hosted sign-in/token refresh was not tested. [Both observations](database-role-findings.md#account-revocation-observations-requiring-a-policy-decision).
3. **FE-04 — Historical headcount:** does Active mean current roster or headcount at the selected month end? A future joiner contributes to the current Active count in a historical report. [Evidence](frontend-findings.md#fe-04--meaning-of-active-in-a-selected-month-headcount-report).
4. **ATT-04 — Paid half-leave with one missing punch:** should provisional missing-punch half credit add to paid half-leave before the actual worked half is verified? The tested output is **0.5 payable day**, while the additive hypothesis expects 1.0. The source calls missing-punch credit provisional, so confirmed underpayment cannot be asserted without that decision. The paid-leave category concern is source-derived rather than a separate executed report-row test. [Attendance evidence](attendance-findings.md).

A separate **QA fixture discrepancy**, not a counted product defect, was observed in local chat pin/unpin: fixture memory changes correctly but the menu label can stay stale. [Details](local-chat-developer-findings.md).

## Fix pass

The subsequent authorized [local fix pass](fixes/README.md) closes the confirmed items and the policy decisions with regression coverage. The chat discrepancy was resolved in fixture serialization. Original reproduction evidence is retained. No hosted migrations, deployment, real account/device changes or real communications were performed.
