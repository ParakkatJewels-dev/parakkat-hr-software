# Local HRMS QA report — 16 September 2026

**The original local QA pass found 21 confirmed defects and one missing clearance workflow. These are now fixed in the subsequent authorized [local correction pass](fixes/README.md).** The results below describe the original pre-fix audit. See the [prioritized bug register](BUG_REGISTER.md) for expected versus actual results and reproduction evidence. Four additional access/pay/headcount policy questions are listed separately.

The user requested testing across different users and designations, validating outputs, and listing bugs before fixing them. The user subsequently confirmed that this pass must stay **isolated locally**. Existing uncommitted product changes were included in the tested source and preserved.

## Users, designations and scope

| Role | Database persona designation | Scope | Browser fixture roster in scope |
| --- | --- | --- | ---: |
| Super Admin | Group Director | Global | 525 |
| Entity Admin | Company Director | Company | 175 |
| HR Manager | HR Manager | Company | 175 |
| Zonal Manager | Zonal Sales Manager | Zone | 88 |
| Branch Manager | Store Manager | Branch | 44 |
| Department Head | Department Supervisor | Department | 22 |
| Employee | Sales Associate | Self | 1 |
| Unassigned linked account | Unassigned Clerk | None | Application entry blocked |

The database uses distinct synthetic login and employee IDs, with actual designation records. Anonymous access is also tested. Browser role sessions use a fresh isolated context for each role, a mocked identity and 525 synthetic employees distributed across **3 companies, 6 zones, 12 branches, 24 departments and 7 designations**. Browser persona designation labels are listed in the raw results; they are representative test labels rather than a business role-to-designation mapping. Cashier and Sales Associate were additionally used together to validate goal selection and multi-person routine assignment. A designation is an organization field; the access role and scope are tested separately.

## Executed validation

| Layer | Result | What this establishes |
| --- | --- | --- |
| Existing frontend suite | **1,101 passed**, 0 failed/skipped | Component, form, permission, query, import/export, navigation, task/chat and helper contracts |
| Existing attendance unit suite | **227 passed**, 0 failed/skipped | Engine, device transport mocks, exports, API and job logic |
| Attendance SQL engine integration | **8 passed**, 0 failed/skipped | Real disposable PostgreSQL recalculation/queue behavior |
| Existing database suite | **144 migrations**, **1,259 role assertions** passed; 34 reported contract groups | Real SQL/RLS, successful and denied operations, workflow guards |
| Attendance role HTTP checks | **249 requests passed** | Seven roles, exact scoped outputs, invalid identities and restricted operations; identity/external effects mocked |
| Attendance report SQL/XLSX | Passed across **503 employees** | Exact report arithmetic and serialized/reopened workbook cells; employee count is data volume, not a test count |
| Browser role/route sweep | **674 checks passed**, no page errors or external requests | 47 screen/subtab paths plus keyboard skip for 7 roles at 1440px and 390px, plus unassigned blocking at both sizes |
| Additional browser workflows | **21 passed / 1 confirmed product failure** | Synthetic ticket/leave/routine/goal/category actions, own payslip breakdown, settings persistence, invalid routes, calendar for all 7 roles, detail access; failure confirms FE-01 |
| Local chat/developer browser flows | **5 passed / 1 partial fixture discrepancy** | Synthetic send/reply/search and unusable API key create/revoke; chat repin label discrepancy remains unconfirmed as a product issue |
| Additional database probes | **55 checks: 44 passed / 11 failed** | 9 failed cases represent 6 bugs; 2 are access-revocation policy observations |
| Additional attendance probes | **7 checks: 2 controls passed / 5 failed expectations** | Four confirmed defects plus one policy-dependent payable-day hypothesis (ATT-04) |
| Payroll generation/publication probes | **17 checks: 11 passed / 6 failed** | Four distinct payroll defects plus controls for role restrictions, salary constraints, caps, reruns and published-run protection |
| Additional frontend reproductions | 10 rendered cases + 2 real-handler observations | Seven frontend defects, one workflow gap and one business-meaning question; these scripts assert faulty observations, so their successful exit does not mean product success |
| Build/static checks | Web build, web lint, attendance typecheck/build passed | Lint has 32 warnings; no product edits were made to address them |

Counts above have different units and sometimes overlap; they must not be summed into a single “all tests” total. Green baseline suites did **not** establish functional correctness: the new edge-case and workflow checks reproduced the listed defects.

## Browser workflow outputs

- Employee creates an IT ticket: one Open/High record, correct routed department, own status-management control absent.
- Department Head resolves a ticket: actionable queue decreases **15 → 14**, and the resolved ticket disappears from Needs action.
- Department Head approves leave: status remains Pending and stage becomes HR; HR sanction separately produces Approved/completed. Remarks/history are saved; self-approval controls stay absent.
- Denied ticket write retains the typed input and creates zero records.
- Employee ticks and unticks today's routine job: exactly one completion is added, then removed for that date.
- HR selects a Cashier by designation and creates an Active goal at 0% progress.
- HR assigns a two-job monthly routine to a Cashier and a Sales Associate; day 32 is blocked and day 31 is accepted.
- Entity Admin creates and deactivates a category; it disappears from new-ticket choices.
- Employee expands own sample payslip: gross **₹22,000**, deductions **₹2,000**, net **₹20,000**, no other employee or payroll-run action.
- Clock preference survives reload; invalid routes return the missing-page screen; ordinary Employee is denied manager Directory detail.

These browser writes are **in-memory fixture transactions**. The sample employee payslip starts with Published status and renders correctly. The actual SQL publish workflow has a different defect, PAY-04, which is why the successful presentation check does not establish publish-to-employee delivery.

## Coverage and limits

The [27-module control inventory](frontend-coverage.md) lists controls, executed evidence and remaining gaps. The browser audit opened every current main screen and listed subtab, including an extra calendar check outside the original sweep, and exercised selected workflows beyond navigation. It is **not an assertion that every option, permutation and persisted lifecycle has passed**. Empty fixture screens do not prove CRUD correctness.

Kept outside this local pass: live sign-in/email delivery, hosted PostgREST/Storage transport and real file transfer, physical BioTime devices, external integrations, native iOS/Android shells, actual push/realtime delivery across devices, production load, arbitrary custom-role combinations, and statutory payroll compliance. Local component/API/SQL coverage exists for many of their internal rules, as identified in the module reports. Full asset custody, import provisioning, document upload and every task/organization/account lifecycle still require additional integrated acceptance cases; they are coverage backlog, not silently marked passed.

No real accounts were created. No production HR records, actual payments, real messages or emails, device settings, or hosted migrations were changed. QA scripts and evidence were added; normal builds produced their ignored build outputs.

## Evidence and reruns

- [Database roles, designations and defects](database-role-findings.md)
- [Attendance calculations and defects](attendance-findings.md)
- [Payroll generation and publication](payroll-findings.md)
- [Frontend findings](frontend-findings.md) and [module/control inventory](frontend-coverage.md)
- [Browser role results](evidence/browser-role-results.json) and [workflow results](evidence/browser-workflows.json), with screenshots in `evidence/`
- [Local messaging/developer browser findings](local-chat-developer-findings.md), [results](local-chat-developer-results.json) and [reproduction](local-chat-developer-browser.mjs)
- [Database probe results](database-extra-results.json), [payroll probe results](payroll-results.json), [frontend render observations](frontend-reproductions.json), and [recruitment handler observations](recruitment-form-reproductions.json)
- [Tested source manifest](tested-source-manifest.json): commit and SHA-256 hashes for 553 source/fixture files, including the existing working-tree changes; no environment/secret files included

The detailed reports include safe local reproduction commands. Database runners copy fixture files before rebuilding a private disposable PostgreSQL cluster, preserving existing tracked fixtures. Repro scripts intentionally retain failing expectations or explicitly assert the faulty observations; check each script's stated exit semantics.

For browser checks, start `npm --prefix web run qa:browser`, then run `node docs/qa/2026-09-16/browser-audit.mjs` and `node docs/qa/2026-09-16/browser-workflows.mjs` with Playwright installed. If needed, set `HR_QA_PLAYWRIGHT` to an existing Playwright `index.mjs`. Chrome is launched with a fresh temporary profile, external requests are blocked, and the QA server replaces Supabase with synthetic fixtures. The regular application server must not be substituted for this QA server.

The QA server and browser sessions started for this audit were stopped afterward. No changes were committed or deployed.
