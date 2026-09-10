# User and role fixes — 10 September 2026

This is a focused source-code and isolated-test audit, not a certification of the live Supabase
project. No production passwords, employee links, roles, or email settings were changed.

## Findings fixed in this change

| Issue | Fix |
| --- | --- |
| No forgotten-password or admin reset option | Login → **Forgot password?** and Administration → Users & Access → **Reset password**. Admin actions request an email for the target account; they do not change the administrator's password. |
| Recovery links fell into normal routing | A verified `PASSWORD_RECOVERY` session opens the new-password form ahead of role checks. Recovery intent survives refresh in the same tab, bound to that user. Unverified/expired links offer another request. |
| Password rules differed; rejected requests could leave forms busy | Forced, recovery and voluntary changes use the shared eight-character/name/number rules. Login and password forms release busy state on thrown errors. |
| Failed access lookup caused an endless loader; old requests could overwrite another user's access | Retry/sign-out error state; identity and request-generation guards discard stale responses. |
| Edited role permissions and employee links left stale views | Refresh on role/permission realtime events, local mutations, focus and a visible-tab safety poll; invalidate affected user, employee and role queries. |
| A global persisted query cache could cross account boundaries | Fresh access is required before restoring a per-user cache. The cache version also includes permissions, employee scope and hidden screens. Identity/access changes create a new in-memory cache; late writes from an old owner are blocked. |
| Role revocation could report success after an RLS-filtered zero-row delete | Require a returned deleted row; otherwise show an actionable error. |
| Admin controls did not match rank/scope restrictions | Deletion/reset controls require both seniority and employee scope. Revocation checks the assignment scope. Unlinked logins are linkable only by Super Admin. Unknown roles fail closed. |
| Role dropdown accepted duplicates, missing employee self-scope, or stale scope selections | Validate current choices and duplicates; prevent closing the dropdown during a pending mutation. User search resets pagination. |
| Create-user and optional employee linking were separate transactions | New atomic RPC; failed linking/promotion rolls back the login and identity. The optional `invite-user` Edge Function uses the same RPC with the caller's JWT. |
| Employee linking could overwrite an existing login or repoint a senior account | Lock employee rows, check both sides of an existing link, reject occupied employees and enforce target-user seniority on the server. |
| Last-admin protection did not cover direct role removal or simultaneous demotions | Table triggers cover profile flags and global Super Admin assignments, with one transaction lock shared by removal paths. |
| Super Admin promotion/demotion happened on one click | Explicit confirmation names the account and explains full-access consequences. |

## Verification

- `npm --prefix web test`: includes new unit tests for reset requests, auth races, cache ownership,
  scopes, zero-row revocation, duplicate grants and atomic creation, plus server-rendered component
  checks for login/recovery forms and delegated admin controls.
- `npm --prefix web run build`: production build.
- `backend/tests/user_account_integrity.sql`: executed against a disposable local PostgreSQL
  database named `hr_account_audit`. Uses minimal auth/RBAC fixtures and the actual RPC/migration
  files. Checks rollback of auth users/identities/profiles, link consistency, password-change
  flags, rank/scope rejections, RPC grants, and last-admin protection.
- Two concurrent local demotions were also tested: one committed, the other was rejected, and
  one Super Admin remained.
- Browser interaction and mobile visual checks were blocked by an open Chrome extension panel.
  Live email delivery, the deployed Edge Function, and the complete production RLS configuration
  have not been exercised.

## Required rollout

1. Apply pending migrations in order, including
   `supabase/migrations/0120_user_account_integrity.sql`, **before** deploying this frontend.
   The create-user panel explicitly reports a missing RPC instead of falling back to partial
   account creation. Existing historical employee-link inconsistencies are not automatically
   rewritten; review those accounts separately.
2. Deploy/rebuild the web app. If using the optional `invite-user` function, redeploy it after the
   migration too; it now uses the platform's `SUPABASE_ANON_KEY` and the caller's JWT.
3. In Supabase Auth URL Configuration, set the production Site URL and allow the exact recovery
   redirect, for example `https://your-hr-domain.example/?auth=recovery`. Include any hosted base
   path. Do not append a hash route: the current auth client consumes the token fragment itself.
   See [Supabase redirect configuration](https://supabase.com/docs/guides/auth/redirect-urls).
4. For native builds, set `VITE_PUBLIC_APP_URL` to the deployed HTTPS app base before building.
   Native requests send users to that web recovery page; a Capacitor local origin cannot host an
   emailed web link. Web builds default to their current origin/base path when this is unset.
5. Verify the Auth reset-password email template and mail provider with an approved test account.
   Keep the standard verification link (`{{ .ConfirmationURL }}`), rather than an unverified
   direct link to the form. The implementation follows the two-step
   [Supabase password-recovery API](https://supabase.com/docs/reference/javascript/auth-resetpasswordforemail).
   The generic confirmation does not prove that a mailbox exists or that delivery succeeded.
6. Smoke-test a valid reset link, an expired/reused link, a same-tab refresh during recovery,
   sign-out/account switching, a delegated manager's controls, and phone-width layouts before
   releasing. Do not use a real employee's account for destructive tests.
