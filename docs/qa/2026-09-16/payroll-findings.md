# Payroll generation QA — 2026-09-16

**Result:** four distinct payroll defects were reproduced using the actual database payroll functions after replaying all **144 application migrations**. The **17 targeted assertions produced 11 passes and 6 failures**; three failed assertions concern the same publication/visibility defect. No application changes or fixes were made.

This covers salary calculation and publication, separately from the attendance XLSX report tests. All data was synthetic and stayed in an independent disposable PostgreSQL cluster. The runner copies migration/test files into a temporary directory, so it does not overwrite the repository's shared permission fixtures. No `.env`, remote connection, bank/payment service or real employee payroll was used.

## Evidence and exact results

| Check | Result | Evidence |
| --- | --- | --- |
| Existing salary draft arithmetic/validation tests | **6 passed, 0 failed, 0 skipped** | `node --test web/src/lib/salaryDraft.test.js`; [log](logs/payroll-salary-draft.log). |
| Full schema and authorization bootstrap | **144 migrations replayed; 1,259 baseline role assertions passed** | [Log](logs/payroll-probes.log). This repeats the shared baseline and must not be added again to the overall unique role-test count. |
| Real payroll SQL, salary structures, pay components, run and publish | **17 assertions: 11 passed, 6 failed** | [SQL probes](payroll-probes.sql), [structured actual/expected results](payroll-results.json), [log](logs/payroll-probes.log). |

The existing repository SQL tests cover payslip permissions and attendance/leave locks, but inspection found no existing direct invocation of `run_payroll`, `publish_payroll` or `delete_draft_payroll` in `web/backend/tests/*.sql`. The added QA probes execute those functions.

## Passing controls

The 11 passing assertions verify:

1. A full month pays the agreed ₹30,000 and ignores a ₹60,000 structure effective in a future month.
2. ₹20,000 Basic plus ₹10,000 named HRA become the correct payslip earning lines.
3. Re-running a draft leaves one payslip with two lines rather than duplicating them.
4. Database validation rejects Basic greater than Gross (`23514`).
5. Explicit `is_lop=true` days correctly reduce the salary to ₹15,000 for 15 paid days out of 30.
6. Percentage deduction base caps, maximum component amount, employer contributions, inactive components, eligibility thresholds and another entity's component produce the expected combined result: gross ₹15,000, deductions ₹400, net ₹14,600, employer cost ₹450.
7. An employee cannot read their own draft payslip.
8. An employee cannot invoke payroll generation.
9. Publishing changes the payroll run to `Published`.
10. Re-running a published period is rejected.
11. Deleting a published run is rejected.

The percentage/scope case is one combined assertion, not a separate test per setting. The payroll actor is the migration-seeded HR manager scoped to the employee's entity. Publication visibility is queried as the employee's own distinct authenticated identity under actual PostgreSQL RLS.

## Confirmed defects

<a id="pay-01"></a>

### PAY-01 — High: recorded absences and half-days no longer reduce salary

- **Setup:** September 2026, monthly gross ₹30,000, Basic ₹20,000, 30 synthetic attendance dates. One working day is `Absent` with `day_fraction=0`; another is `Half Day` with `day_fraction=0.5`. Both correctly retain `is_lop=false` because they are attendance outcomes, not an approved LOP leave type.
- **Expected:** 1.5 unpaid days, 28.5 paid days, gross **₹28,500**.
- **Actual:** 0 unpaid days, 30 paid days, gross **₹30,000**.
- **Source:** `web/backend/supabase/migrations/0097_named_salary_gross_components.sql:110` sums unpaid fractions only when `a.is_lop` is true. The previous explicit attendance-based rule in `0075_unpaid_days_come_from_the_day_itself.sql:94` used the fraction of every working day. Migration 0097 replaces that corrected function and restores the older behavior.
- **Impact:** payroll pays full days for recorded absences/partial payable days; its monetary result diverges from attendance credit. This is a software-contract regression confirmed against the repository's own documented rule, not a proposed statutory policy.
- **Reproduction result:** `PAY-01/absence and half-day reduce payable days` in [payroll-results.json](payroll-results.json).

<a id="pay-02"></a>

### PAY-02 — High: fixed components ignore “Reduce with unpaid days”

- **Setup:** same monthly salary, 15 explicit LOP days in a 30-day month. Add fixed deduction ₹3,000 with `prorate_on_lop=true`.
- **Expected:** gross ₹15,000, deduction **₹1,500**, net **₹13,500**.
- **Actual:** gross ₹15,000, deduction **₹3,000**, net **₹12,000**.
- **Source:** `0097_named_salary_gross_components.sql:172` takes the complete fixed amount without applying paid-day ratio. The earlier fix at `0075_unpaid_days_come_from_the_day_itself.sql:150` explicitly applied that ratio. The current form still exposes the setting at `web/src/components/Payroll.jsx:842` with the label “Reduce with unpaid days”.
- **Impact:** employees can be over-deducted by fixed deductions despite the selected setting. The same fixed calculation path also serves allowances/employer components; those variants were not counted as separate executed tests.
- **Reproduction result:** `PAY-02/fixed deduction obeys Reduce with unpaid days`.

<a id="pay-03"></a>

### PAY-03 — High: a component marked “part of gross” can inflate agreed gross

- **Setup:** full month, structure ₹20,000 Basic + ₹10,000 named HRA = **₹30,000 agreed monthly gross**. Add a ₹5,000 earning component using the form's “Allowance (part of gross)” option.
- **Expected:** the salary still totals **₹30,000**, or an incompatible breakdown is rejected for review. A component represented as part of the agreed gross must not silently raise that gross.
- **Actual:** payslip gross and net both become **₹35,000**.
- **Source:** `0097_named_salary_gross_components.sql:141` adds the per-employee named components; `:184` then also adds earning components. When the resulting total exceeds the agreed gross, `:196` computes a negative balancing amount, and the `if _other > 0` branch simply skips it. The configured component UI identifies earnings as “Allowance (part of gross)” at `web/src/components/Payroll.jsx:805`; the migration itself says the structure's gross remains the agreed monthly gross.
- **Impact:** salary structures created through the current named-component UI can be double-counted when the general allowance catalog is also used.
- **Reproduction result:** `PAY-03/named structure and part-of-gross component preserve agreed gross`.

<a id="pay-04"></a>

### PAY-04 — High: publishing payroll keeps employee payslips invisible

- **Setup:** HR runs a valid draft for the employee, then calls the real `publish_payroll` function. Query the employee's own payslip and lines under their authenticated role.
- **Expected:** published run; employee sees **1 payslip and its 2 earning lines**.
- **Actual:** run becomes `Published`, but the payslip becomes **`Paid`**. The employee sees **0 payslips and 0 lines**.
- **Source:** `web/backend/supabase/migrations/0041_payroll_engine.sql:187` writes `payslips.status='Paid'`. The later employee RLS policy at `0095_drafts_are_not_payslips_yet.sql:19` requires `status='Published'`. No later migration replaces the publishing function to match that policy.
- **Impact:** HR completes publication successfully, yet “My Payslips” remains empty for the staff member. The existing role matrix seeded `Published` rows directly, so it passed without exercising the actual producer of payslip status.
- **Reproduction results:** all three `PAY-04/...` assertions; this is **one defect**, not three bugs.

## Reproduce safely

```sh
node docs/qa/2026-09-16/run-payroll-probes.cjs
```

The [runner](run-payroll-probes.cjs) requires local PostgreSQL tools on `PATH`, runs the actual migration history in a private Unix-socket cluster, writes results in this QA folder, and stops/deletes the cluster in `finally`. Exit 1 currently means the six documented expectations failed; infrastructure failure uses exit 2.

## Remaining gaps

- This bounded pass does not establish correctness for every salary amount, rounding boundary, leap-month case, midmonth joining/leaving, historical inactive employee, missing attendance date, retroactive raise, overlapping component scope, malformed component or concurrent run/publish race.
- The successful combined component test exercises one percentage/basic cap and one percentage/gross employer contribution. It is not an exhaustive matrix of every rate/base/eligibility combination.
- Draft deletion's successful cascade, salary edit mutations from the browser, component create/edit/delete browser flows and payslip visual rendering were not added to this payroll SQL pass. The executed lifecycle checks cover generation, idempotent re-run, publication, unauthorized run, and rejection of re-run/delete for a published period.
- No bank transfer, payroll disbursement, legal/statutory rate correctness or compliance research was performed. Amount expectations come only from the application's configured arithmetic and stated contracts.
- All four defects remain unfixed for the user's review phase.
