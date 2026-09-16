# Migration 0144 ownership correction

The user reported `0144_immediate_account_revocation.sql` failing with `must be owner of table migrations` after 0141–0143 completed successfully.

The migration's policy loop covered every RLS-enabled table in both `public` and `storage`. That unnecessarily included Storage's internal migration/configuration tables, whose policy ownership differs from application tables. The original local platform fixture did not model those internal tables and ownership boundaries.

The corrected loop covers RLS-enabled public application tables and `storage.objects`, matching the existing document, asset-photo, task-file and chat-media policies. It does not change Storage metadata ownership or suppress ownership errors on application tables. The account-revocation coverage assertions use the same intended scope.

For the error shown, the failed statement occurred before 0144's COMMIT, so the migration was rolled back and was not recorded as applied. Run `npm run migrate` again in `web/backend`: successfully recorded files are skipped, then 0144 is retried and 0145–0146 follow. No baseline or table-ownership changes are required.

Validation uses a disposable local PostgreSQL cluster with a non-superuser migration owner and separately owned Storage metadata. No environment credentials or hosted database were accessed by this correction pass. See the accompanying validation log for final results.

## Validation result

The final [full database suite](database-tests.log) passed: **149 migration files, 1,259 standard-role assertions**, the existing request/revocation/payroll/report contracts, and three new ownership regression groups. Those groups reproduce the exact old error, apply patched 0144 twice with separately owned metadata, verify active/banned account behavior, and ensure unexpected application-table ownership errors remain visible. JavaScript syntax and diff checks also passed.

An initial integrated test copy predated the fixture's Storage-schema USAGE grant to its platform owner; that fixture-only failure is retained in `database-tests-initial-fixture.log`. The corrected fixture and final suite pass. Earlier QA evidence and dirty shared role fixtures were preserved.
