# Attendance and payroll QA — 2026-09-16

**Result:** the existing attendance suites pass, but targeted output checks reproduce **four confirmed defects and one policy-dependent question (ATT-04)**. No application code was changed or defect fixed. All writes made by these checks were to disposable local PostgreSQL clusters or QA evidence files; no production database, BioTime device, employee account, or live payroll data was changed.

## Executed checks

| Check | Result | Evidence / scope |
| --- | --- | --- |
| `npm --prefix services/attendance test` | **227 passed, 0 failed, 0 skipped** | [Unit log](logs/attendance-unit.log). Engine rules, date ranges, scale, HTTP auth/scoping/rate limits, export queue, read-only device transport, sync cursors/mapping/cancellation, background commands and scheduling. |
| `npm --prefix services/attendance run test:engine` | **8 passed, 0 failed, 0 skipped** | [Engine integration log](logs/attendance-engine.log). Real SQL on disposable PostgreSQL; 503 employees, locked/pre-hire rows, historical inactive shift, queue generations, future dates, cancellation/retry and concurrent recomputes. |
| `npm --prefix services/attendance run test:reports` | **Passed** | [Report log](logs/attendance-reports.log). Actual report SQL, 503 employees, paid leave/LOP/fractional days, multiple device enrolments, inactive employees, denied/empty scopes, custom column totals, XLSX generation and reload. Script does not publish an assertion count; do not count this as 503 independent tests. |
| `npm --prefix services/attendance run test:roles` | **249 HTTP requests passed** | [Role log](logs/attendance-roles.log). Seven standard roles, migration-derived permission grants, actual local report/scope SQL; identity and external operational side effects mocked. 144 migrations represented in the loaded fixture. |
| `npm --prefix services/attendance run typecheck` | **Passed, exit 0** | TypeScript `--noEmit`. |
| `npm --prefix services/attendance run build` | **Passed, exit 0** | TypeScript production compilation. |
| Additional attendance output probes | **1 control passed, 4 failed expectations** | [Reproduction](attendance-edge-repro.cjs), [output](logs/attendance-edge.log). Direct execution of production TypeScript rules with synthetic dates/punches and mocked environment. Three failures confirm defects; ATT-04 tests an unconfirmed policy hypothesis. |
| Additional frontend regularization probes | **1 control passed, 1 failed expectation** | [Reproduction](night-regularization-repro.mjs), [output](logs/attendance-night.log). Executes real `useCreateRegularization().mutationFn` with React Query/Supabase mocked; captures the inserted payload. |

Test runtime: Node v26.0.0 with local PostgreSQL 16 available. Unit and integration test counts are separate from HTTP request counts and report data volumes.

## Role output validation

These are distinct synthetic users and organization scopes, not merely a single administrator viewing different labels. Standard job designations beyond these seven roles are covered by the broader QA work, not claimed by this attendance suite.

| Persona | Scope | Expected and actual exported employees | Scoped recompute | Global diagnostics / device operations |
| --- | --- | ---: | --- | --- |
| Super administrator | Global | 6 | Allowed | Allowed |
| Entity administrator | Entity | 5 | Allowed | Denied |
| HR manager | Entity | 5 | Allowed | Denied |
| Zonal manager | Zone | 3 | Allowed | Denied |
| Branch manager | Branch | 2 | Allowed | Denied |
| Department head | Department | 0 | Denied | Denied |
| Employee | Self | 0 | Denied | Denied |

The role suite also tests unauthenticated/invalid/missing access, unlinked employee, mixed manager scope, unrelated global grants, selected scopes and query/operation validation. Report export access is a separate permission from an employee's own attendance UI.

## Findings for review before fixing

### ATT-01 — High: approved missing check-in discards the actual departure

- **Scenario:** employee has one device punch at 16:30 IST on 2026-07-15. HR approves a check-in-only correction at 09:00. Shift is 09:00–17:30; 40-minute excess break policy. This is a supported correction shape: the schema allows either timestamp independently.
- **Expected:** check-in 09:00, actual check-out 16:30, 450 worked minutes, corrected missing-punch state. For the flexible shift used in the reproduction, the completed attendance should receive its normal full-day credit.
- **Actual:** check-out is `null`; the engine reconstructs to 17:30 and returns **510 minutes**, `Missing Punch`, `isMissingPunch=true`, **0.5 payable day** under `missedPunchPolicy='exception'`.
- **Cause:** `processDay.ts:282` assumes a single punch is check-in and sets check-out only for two or more punches. `:287` then replaces that check-in with the correction, losing the one actual departure. The remaining path reaches the single-punch reconstruction at `:430`.
- **Impact:** approved corrections fail to resolve attendance and can overstate hours while understating payable days. Under `missedPunchPolicy='present'`, the lost departure/wrong hours remain even though the payable fraction differs.
- **Proof:** `ATT-01` in [attendance-edge-repro.cjs](attendance-edge-repro.cjs); actual output in [attendance-edge.log](logs/attendance-edge.log).

### ATT-02 — High: approving a missing departure fails to rebuild break accounting

- **Scenario:** punches are 09:00, 12:00 (break start), 13:30 (break end). HR approves missing check-out 17:30. Same 40-minute excess break policy.
- **Expected:** the corrected timeline is 09:00 → 12:00 / 13:30 → 17:30; break 90 minutes, chargeable excess 50 minutes, **460 worked minutes**, no missing-punch flag.
- **Actual:** **510 worked minutes**, break **0**, `breaksIncomplete=true`, `isMissingPunch=true`.
- **Cause:** raw sessions are calculated before applying the regularization (`processDay.ts:275`), and the corrected endpoint never causes those sessions to be recalculated. The missing flag still uses the raw odd punch count at `:628`.
- **Impact:** recorded worked hours are inflated by 50 minutes in this case; on longer days this can inflate overtime, and an approved correction remains in the exceptions list.
- **Proof:** `ATT-02` in [attendance-edge-repro.cjs](attendance-edge-repro.cjs).

### ATT-03 — Medium: a completed correction on a rest day retains an incorrect missing-punch exception

- **Scenario:** Sunday 2026-07-19, actual punch 09:00, approved check-out 11:00.
- **Expected:** 120 worked minutes and no missing-punch exception because both endpoints are available.
- **Actual:** 120 minutes are correctly credited, but `isMissingPunch=true`. The remarks additionally state that no hours can be measured/credited, contradicting the actual credited hours.
- **Cause:** the weekly-off/holiday branch at `processDay.ts:390` checks raw `punchCount === 1` even after the correction supplied check-out.
- **Impact:** false unresolved attendance exceptions after HR approval; misleading attendance remarks.
- **Proof:** `ATT-03` in [attendance-edge-repro.cjs](attendance-edge-repro.cjs). The same branch handles holidays; the executed example is a weekly off.

### ATT-04 — Policy-dependent: should paid half-day leave add to provisional missing-punch credit?

- **Scenario:** approved paid leave of 0.5 day, one morning punch at 09:00, shift using `missedPunchPolicy='exception'`.
- **Hypothesis tested, not an established requirement:** paid leave 0.5 plus provisional missing-punch credit 0.5 would equal **1 payable day**, with leave retained and the missing-punch exception still visible.
- **Actual, confirmed:** **0.5 payable day** and `Missing Punch` status. The paid half-leave and provisional attendance credit are combined with `max`, not added.
- **Policy uncertainty:** `processDay.ts:547` describes the missing-punch fraction as “half pending regularization”, while `:687` says a paid half-day leave plus a **worked** half produces a full day. These comments do not establish that provisional attendance credit must be additive to paid leave. Confirm that business rule before classifying the result as underpayment or changing it.
- **Execution path:** `processDay.ts:548` returns before the paid half-day combination at `:688`. The outer adjustment at `:703` handles only unpaid leave.
- **Related report inference:** the `paid_leave_days` SQL expression at `exports/payrollExport.ts:97` includes paid leave only for `On Leave` status, so the reproduced `Missing Punch` row would not contribute to that category. This is derived from the report source; the exact reproduced row was **not** executed through the report SQL.
- **Proof and classification:** `ATT-04` in [attendance-edge-repro.cjs](attendance-edge-repro.cjs) retains the original hypothesis and failed result for traceability. It is **one policy question, not a confirmed defect**. It applies to exception-policy shifts; no claim is made that the current default shift uses that policy.

### ATT-05 — High: the correction form cannot represent a shift crossing midnight

- **Scenario:** employee submits work date 2026-07-15, check-in 22:00, check-out 06:00 for a night shift.
- **Expected payload:** check-in `2026-07-15T16:30:00.000Z`, check-out **`2026-07-16T00:30:00.000Z`**.
- **Actual payload:** check-in `2026-07-15T16:30:00.000Z`, check-out **`2026-07-15T00:30:00.000Z`**. Check-out precedes check-in by 16 hours.
- **Cause:** `web/src/data/regularizations.js:65` applies the same work date to both times; the form (`web/src/components/Attendance.jsx:1051`) supplies no separate end date or next-day indicator. The schema's `reg_order_check` (`web/backend/supabase/migrations/0014_leave_regularization.sql:106`) requires check-out after check-in whenever both are supplied.
- **Impact:** a valid overnight correction is constructed as an invalid database row. A checkout-only night correction would likewise be dated on the starting morning rather than the following morning; that variant was identified from the same code but is not counted as a separate executed scenario.
- **Proof:** [night-regularization-repro.mjs](night-regularization-repro.mjs) executes the actual mutation and validates its captured payload; [output](logs/attendance-night.log). The database rejection follows the explicit checked schema constraint; this reproduction does not claim to have made a live Supabase request.

## Reproduction commands

Run from the repository root:

```sh
services/attendance/node_modules/.bin/tsx --experimental-test-module-mocks docs/qa/2026-09-16/attendance-edge-repro.cjs
node docs/qa/2026-09-16/night-regularization-repro.mjs
```

Both currently exit with code 1 on the recorded failed expectations. ATT-04's failure is against a policy hypothesis, so that one expectation should be settled by the approved business rule before becoming a regression test. These scripts are QA artifacts outside the normal test suite and have no network or database side effects.

## Boundaries and remaining validation

- Real BioTime connectivity, terminal firmware, device credentials, scheduled production jobs and live sync/backfill were not exercised; the existing tests use fixtures/mocks for these external effects.
- Supabase identities are mocked in service role tests. Local SQL/report scope enforcement is real, but this is not a claim that production login or real JWT issuance was tested.
- XLSX outputs were serialized and reloaded with exact cell assertions; visual workbook review in Excel was not performed.
- All five additional scenarios were executed through real rule/mutation code: four confirm defects, and ATT-04 needs a policy decision. Browser clicks, an actual multi-step approval through Supabase, and real payroll disbursement were not required for these reproductions and are not claimed.
- No statutory salary deduction, tax, benefit or compliance correctness is asserted by attendance report tests.
- Existing repository modifications were preserved. New files are restricted to this QA folder, and the ordinary service build produced its ignored compilation output.
