-- Shut the anonymous internet out of the employee records.
--
-- Found by a security audit of the public deployment. Two independent holes, both reachable by
-- anybody at all: the anon key is published in the browser bundle by design, so "anon" here means
-- a stranger with curl, no login and no password.
--
--   as anon:  employees  -> 0 rows      RLS holding
--             attendance -> 0 rows      RLS holding
--             payslips   -> 0 rows      RLS holding
--             employee_payroll_readiness -> 162 rows     <-- every employee
--
-- Nothing suggests either hole was used. Both are closed here.

-- =================================================================================================
-- 1. A view that ran as its owner, so RLS never applied
-- =================================================================================================
-- public.employee_payroll_readiness selects from employees. It is owned by postgres, which holds
-- rolbypassrls, and it was created WITHOUT security_invoker — so it executed with the owner's
-- rights and RLS on employees was never consulted. 0047 granted it to `authenticated` only, but
-- Supabase's default privileges on the public schema hand every new object to `anon` as well, and
-- nothing in the migration undid that.
--
-- It was not merely readable. pg_relation_is_updatable reported 28 — INSERT, UPDATE and DELETE —
-- and anon held all three. A single unauthenticated request
--
--     DELETE /rest/v1/employee_payroll_readiness?id=not.is.null
--
-- would have deleted all 162 employees, cascading through attendance (58,500 rows), payslips,
-- salary structures, documents, leaves, expenses and the rest.
--
-- security_invoker makes the view run as the caller, so the RLS on employees applies through it
-- exactly as it does to the table. The revoke is belt and braces: a view nobody may reach cannot
-- leak even if the invoker setting is lost in a later rebuild.
alter view public.employee_payroll_readiness set (security_invoker = true);
revoke all on public.employee_payroll_readiness from anon;

-- =================================================================================================
-- 2. Eight SECURITY DEFINER functions that read "no JWT" as "trusted"
-- =================================================================================================
-- Each guards itself with some form of
--
--     _privileged := auth.uid() is null or app.is_super_admin();
--
-- The intent is documented and reasonable: a service_role connection or the SQL editor carries no
-- JWT, and seed scripts have to work. The flaw is that PostgREST's anon role has no JWT either.
-- auth.uid() is NULL for a stranger exactly as it is for a seed script, so every one of these
-- treated an anonymous caller as fully privileged.
--
-- What that allowed, without logging in:
--   grant_app_access        create a login with a chosen password and attach super_admin/global
--   link_user_to_employee   repoint any existing login, including an admin's, at any employee
--   run_payroll             delete and rewrite every payslip in a period
--   publish_payroll         mark a period Published/Paid
--   report_attendance_*     read company-wide attendance totals for all 162 people
--   enqueue_recompute       queue arbitrary recompute work
--   resolve_punch_links     re-parent punches between employees
--
-- The fix is to revoke rather than to rewrite the guard. Rewriting it means picking a test for
-- "trusted" that holds inside a SECURITY DEFINER context, where current_user is already the owner
-- and session_user is the pooler — easy to get subtly wrong, and wrong here fails open. Revoking is
-- exact: none of these is called before login, from the browser or anywhere else. The web client
-- calls them as `authenticated`, where auth.uid() is non-null and the existing guards work
-- correctly; the attendance service uses a direct Postgres connection, not anon; seeds use
-- service_role. So the anon grant was never anything but the default privilege nobody removed.
--
-- Left executable by `authenticated` on purpose — that is the path the app uses, and it is guarded.
-- Revoked from PUBLIC, not from anon.
--
-- Revoking from anon alone is a no-op here and silently looks like it worked. The ACL on each of
-- these reads
--
--     =X/postgres  postgres=X/postgres  authenticated=X/postgres  service_role=X/postgres
--
-- and that leading `=X` with no grantee IS the grant to PUBLIC, which anon inherits by being a
-- role. `revoke ... from anon` removes a direct grant that was never there, and
-- has_function_privilege('anon', ...) still returns true afterwards — verified, it did.
--
-- `authenticated` and `service_role` hold their own explicit grants, so revoking PUBLIC leaves the
-- app and the seed scripts exactly as they were. Both are named again below so a future reader can
-- see that keeping them is deliberate rather than an oversight.
--
-- Signatures are written out in full, including parameter names, exactly as pg_proc reports them.
-- Guessing at them cost a rolled-back migration: `grant_app_access(uuid,text,text,text,text,uuid)`
-- does not exist, because the fifth argument is the enum `scope_type`, not text.
revoke execute on function public.enqueue_recompute(_employee_id uuid, _from date, _to date, _reason text) from public, anon;
grant  execute on function public.enqueue_recompute(_employee_id uuid, _from date, _to date, _reason text) to authenticated, service_role;
revoke execute on function public.grant_app_access(_employee_id uuid, _email text, _password text, _role_key text, _scope_type scope_type, _scope_id uuid) from public, anon;
grant  execute on function public.grant_app_access(_employee_id uuid, _email text, _password text, _role_key text, _scope_type scope_type, _scope_id uuid) to authenticated, service_role;
revoke execute on function public.link_user_to_employee(_user uuid, _employee uuid) from public, anon;
grant  execute on function public.link_user_to_employee(_user uuid, _employee uuid) to authenticated, service_role;
revoke execute on function public.publish_payroll(_run_id uuid) from public, anon;
grant  execute on function public.publish_payroll(_run_id uuid) to authenticated, service_role;
revoke execute on function public.report_attendance_exceptions(_from date, _to date) from public, anon;
grant  execute on function public.report_attendance_exceptions(_from date, _to date) to authenticated, service_role;
revoke execute on function public.report_attendance_summary(_from date, _to date) from public, anon;
grant  execute on function public.report_attendance_summary(_from date, _to date) to authenticated, service_role;
revoke execute on function public.resolve_punch_links(_emp_code text) from public, anon;
grant  execute on function public.resolve_punch_links(_emp_code text) to authenticated, service_role;
revoke execute on function public.run_payroll(_entity_id uuid, _period text) from public, anon;
grant  execute on function public.run_payroll(_entity_id uuid, _period text) to authenticated, service_role;

-- =================================================================================================
-- 3. Stop the next object inheriting the same grant
-- =================================================================================================
-- Both holes above come from one cause: Supabase's default privileges give `anon` everything on new
-- objects in public. The view did not ask for that grant and its migration did not mention anon at
-- all. Until the defaults change, the next `create view` in this schema will arrive with the same
-- exposure and nobody will see it in the diff.
--
-- Tables are not affected the same way, because every one of the 45 in public has RLS enabled and a
-- policy — the grant is inert without a matching policy, which is the intended Supabase shape. It
-- is views and functions, which have no RLS of their own, where the default grant IS the access.
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke execute on functions from anon;
