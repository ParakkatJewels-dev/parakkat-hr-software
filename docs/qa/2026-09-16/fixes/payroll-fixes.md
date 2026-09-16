# Payroll corrections: PAY-01–04

Implemented locally in `web/backend/supabase/migrations/0143_payroll_output_integrity.sql`. No remote database was contacted, no published amount was recalculated, and the original audit evidence is unchanged.

- **PAY-01:** unpaid days again come from each working day's unpaid fraction, including recorded absence and half-days. Holidays and weekly offs remain paid.
- **PAY-02:** fixed components obey `prorate_on_lop` for earnings, deductions, and employer contributions. Components with the flag disabled retain their full amount.
- **PAY-03:** employee-specific named earnings and general allowances must fit the prorated agreed gross. Incompatible breakdowns raise a clear `23514` error and roll back the entire generation attempt, preserving the previous draft. Catalog-only structures and compatible mixed breakdowns retain every configured line. Named earnings use cumulative cent rounding so valid partial-month breakdowns reconcile exactly.
- **PAY-04:** new publication writes `Published` payslips. The migration repairs historical `Paid` rows only when their parent run is `Published`; orphan rows and rows in draft runs stay hidden. Existing strict employee RLS is unchanged. Published monetary values are retained.

Generation and publication also lock the payroll run consistently: a draft re-run cannot reset a run that became published while its upsert was waiting.

## Validation

`web/backend/scripts/testPayrollIntegrity.js` is a private-cluster test helper integrated by the main database runner. It creates a separate database, replays the real migration history, executes the old generation/publication functions immediately before 0143, applies 0143 twice, and then executes `web/backend/tests/payroll_output_integrity.sql`.

**33 assertions passed**, including historical status upgrade and monetary preservation; unchanged draft/orphan visibility; distinct HR, employee, and foreign-employee RLS identities; generation → publication → employee visibility; absences, half-days and rest days; fixed proration on/off and employer costs; percentage caps and eligibility/scope controls; named/catalog allowance coexistence and atomic rejection; a 31-day fractional rounding case; idempotent generation/publication; draft deletion; and refusal to regenerate/delete published payroll.

Evidence: [payroll-validation.log](payroll-validation.log).

The earlier PAY-03 audit accepted either preserving agreed gross or rejecting an incompatible breakdown. The new regression exercises the explicit rejection outcome as well as successful compatible configurations; the historical audit probe is intentionally left unchanged.

## Boundaries

This is local arithmetic/lifecycle validation, not statutory-rate verification, payment processing, external integration testing, or exhaustive salary-policy coverage. Existing published amounts are not retroactively corrected. No new claims are made about midmonth joiners/leavers, incomplete attendance, or concurrent payroll stress testing.
