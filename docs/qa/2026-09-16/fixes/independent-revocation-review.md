# Independent review of immediate account revocation

Reviewed the migrated function and policy catalog and the final `0144_immediate_account_revocation.sql`. All public application tables in the replayed schema have RLS; the three public views use `security_invoker`. Public data-returning and mutation RPC paths were traced through the updated permission, employee identity, and explicit account-state helpers.

The review found and reproduced internal helper ACL leaks (including notification writes) and an employee-transfer early-return path. The database implementation now revokes direct API-role access to those internal helpers and checks account state before the affected request/transfer RPC reads. These findings were fixed and independently retested.

A new disposable PostgreSQL cluster replayed the complete migration history and ran the payroll integration helper, followed by the [rolled-back review SQL](independent-revocation-review.sql). **8 review assertions passed**, alongside the unchanged **33 payroll assertions**. This used three synthetic identities and retained each authenticated identity while changing its account status in the database.

The assertions verify:

- A banned identity immediately loses direct employee, profile, and payslip visibility, and cannot obtain its access payload.
- Internal name/password helpers and notification writes are denied; no notification escapes the rejected call.
- The employee-transfer no-op cannot bypass the account guard.
- An inactive linked employee loses its own payslips and messaging directory access.
- An active custom role with `asset.manage` but no `asset.read` still resolves its asset for a permitted photo upload; the same identity loses lookup and upload access after a ban.

[Validation output](independent-revocation-review.log). The SQL expects the synthetic fixture created by `testPayrollIntegrity.js` in `hr_payroll_integrity_audit`; it begins a transaction and rolls all review changes back. This review adds no hosted login, external Storage HTTP, or deployment claim.
