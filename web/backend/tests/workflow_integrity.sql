\set ON_ERROR_STOP on
do $$ begin
  if current_database() <> 'hr_workflow_audit' then
    raise exception 'This test requires a disposable hr_workflow_audit database.';
  end if;
end $$;

create schema auth;
do $$ begin
  if not exists(select from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists(select from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists(select from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;
create table auth.users(id uuid primary key, email text);
create function auth.uid() returns uuid language sql as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to authenticated;
grant execute on function auth.uid() to authenticated;

-- Exercise the application's real ancestry, scoped permissions and RLS rather than replacing
-- authorization with an always-true fixture. Supabase auth alone is represented by a JWT setting.
\ir ../supabase/migrations/0001_init.sql
\ir ../supabase/migrations/0002_org.sql
\ir ../supabase/migrations/0003_identity.sql
\ir ../supabase/migrations/0004_rbac.sql
\ir ../supabase/migrations/0005_functions.sql
\ir ../supabase/migrations/0006_modules.sql
\ir ../supabase/migrations/0007_rls.sql
\ir ../supabase/migrations/0008_seed_rbac.sql
\ir ../supabase/migrations/0012_biotime.sql
\ir ../supabase/migrations/0013_attendance_engine.sql
\ir ../supabase/migrations/0043_goals.sql
\ir ../supabase/migrations/0121_atomic_shift_assignment.sql
\ir ../supabase/migrations/0123_goal_progress_guard.sql

create function public.expect_failure(statement text, expected text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if position(expected in sqlerrm) = 0 then raise; end if;
    return;
  end;
  raise exception 'Expected failure containing: %', expected;
end $$;

insert into public.entities(id, code, name) values
 ('10000000-0000-0000-0000-000000000001', 'A', 'Company A'),
 ('10000000-0000-0000-0000-000000000002', 'B', 'Company B');
insert into public.branches(id, entity_id, code, name) values
 ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'A1', 'Branch A1'),
 ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'A2', 'Branch A2');
insert into auth.users(id, email) values
 ('30000000-0000-0000-0000-000000000001', 'manager@example.test'),
 ('30000000-0000-0000-0000-000000000002', 'employee@example.test');
insert into public.employees(id, entity_id, branch_id, full_name, user_id) values
 ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Staff A', '30000000-0000-0000-0000-000000000002'),
 ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', 'Staff B', null);
update public.profiles set employee_id = '40000000-0000-0000-0000-000000000001'
 where user_id = '30000000-0000-0000-0000-000000000002';
-- A scoped test role exercises exactly the permissions required by the workflows.
insert into public.roles(key, name) values ('audit_manager', 'Workflow test manager');
insert into public.role_permissions(role_id, permission_id)
 select r.id, p.id from public.roles r cross join public.permissions p
 where r.key = 'audit_manager' and p.key in ('employee.read', 'attendance.read', 'shift.manage', 'goal.read', 'performance.manage');
insert into public.role_assignments(user_id, role_id, scope_type, scope_id)
 select '30000000-0000-0000-0000-000000000001', id, 'branch', '20000000-0000-0000-0000-000000000001'
 from public.roles where key = 'audit_manager';
insert into public.role_assignments(user_id, role_id, scope_type)
 select '30000000-0000-0000-0000-000000000002', id, 'self' from public.roles where key = 'employee';
insert into public.shifts(id, entity_id, code, name, start_time, end_time) values
 ('50000000-0000-0000-0000-000000000001', null, 'EARLY', 'Early', '08:00', '17:00'),
 ('50000000-0000-0000-0000-000000000002', null, 'LATE', 'Late', '10:00', '19:00'),
 ('50000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', 'B', 'Company B shift', '09:00', '18:00');
insert into public.employee_shift_assignments(id, employee_id, shift_id, effective_from) values
 ('60000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', '2026-01-01');
insert into public.goals(id, employee_id, title, weight) values
 ('70000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'Serve 100 customers', 50),
 ('70000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002', 'Other branch target', 50);

set role authenticated;
set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000001';
select public.assign_employee_shift('40000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000002', '2026-07-01');
do $$ begin
  assert (select effective_to = '2026-06-30' from public.employee_shift_assignments where id = '60000000-0000-0000-0000-000000000001'), 'old shift closes the previous day';
  assert (select count(*) from public.employee_shift_assignments where effective_from = '2026-07-01' and effective_to is null) = 1, 'one new active shift';
end $$;

-- This fails AFTER attempting to delete the current open assignment: an older closed range
-- overlaps the proposed replacement. The old browser implementation permanently deleted it.
select expect_failure($q$select public.assign_employee_shift('40000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', '2026-06-01')$q$, 'esa_no_overlap');
do $$ begin
  assert (select count(*) from public.employee_shift_assignments) = 2, 'failed replacement rolls back deletion';
  assert (select shift_id = '50000000-0000-0000-0000-000000000002' from public.employee_shift_assignments where effective_to is null), 'original shift survives';
end $$;
select expect_failure($q$select public.assign_employee_shift('40000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000003', '2026-08-01')$q$, 'company');
select expect_failure($q$select public.assign_employee_shift('40000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000001', '2026-08-01')$q$, 'cannot assign');
select expect_failure($q$select public.assign_employee_shift('40000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', '2026-08-02', '2026-08-01')$q$, 'end date');
update public.goals set title = 'Serve 120 customers' where id = '70000000-0000-0000-0000-000000000001';
do $$ begin
  assert (select count(*) from public.goals) = 1, 'branch manager cannot read another branch goals';
end $$;

set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000002';
update public.goals set progress = 75 where id = '70000000-0000-0000-0000-000000000001';
do $$ begin
  assert (select progress from public.goals where id = '70000000-0000-0000-0000-000000000001') = 75, 'employee can record actual progress';
end $$;
select expect_failure($q$update public.goals set title = 'Easier target' where id = '70000000-0000-0000-0000-000000000001'$q$, 'definition');
select expect_failure($q$update public.goals set branch_id = null where id = '70000000-0000-0000-0000-000000000001'$q$, 'definition');
select expect_failure($q$update public.goals set status = 'Dropped' where id = '70000000-0000-0000-0000-000000000001'$q$, 'drop');
select expect_failure($q$select public.assign_employee_shift('40000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', '2026-08-01')$q$, 'cannot assign');
reset role;
do $$ begin
  assert not has_function_privilege('anon', 'public.assign_employee_shift(uuid,uuid,date,date,text)', 'execute'), 'anonymous cannot assign shifts';
  assert (select title = 'Serve 120 customers' and progress = 75 and status = 'Active' from public.goals where id = '70000000-0000-0000-0000-000000000001'), 'definition and progress reconcile';
end $$;

-- An assignment-only role must not need access to personal employee data. A short temporary
-- assignment before an existing future shift must preserve that future commitment.
set request.jwt.claim.sub = '';
insert into auth.users(id, email) values ('30000000-0000-0000-0000-000000000003', 'scheduler@example.test');
insert into public.roles(key, name) values ('audit_scheduler', 'Assignment-only test role');
insert into public.role_permissions(role_id, permission_id)
 select r.id, p.id from public.roles r cross join public.permissions p
 where r.key = 'audit_scheduler' and p.key = 'shift.manage';
insert into public.role_assignments(user_id, role_id, scope_type, scope_id)
 select '30000000-0000-0000-0000-000000000003', id, 'branch', '20000000-0000-0000-0000-000000000001'
 from public.roles where key = 'audit_scheduler';
insert into public.employees(id, entity_id, branch_id, full_name) values
 ('40000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Future shift employee');
insert into public.employee_shift_assignments(id, employee_id, shift_id, effective_from) values
 ('60000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000003', '50000000-0000-0000-0000-000000000001', '2026-09-01');
set role authenticated;
set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000003';
do $$ begin
  assert (select count(*) from public.employees) = 0, 'shift-only role cannot read personal records';
end $$;
select public.assign_employee_shift('40000000-0000-0000-0000-000000000003', '50000000-0000-0000-0000-000000000002', '2026-08-01', '2026-08-15');
do $$ begin
  assert (select count(*) from public.employee_shift_assignments where employee_id = '40000000-0000-0000-0000-000000000003') = 2, 'temporary and future assignments both survive';
  assert (select effective_from = '2026-09-01' and effective_to is null from public.employee_shift_assignments where id = '60000000-0000-0000-0000-000000000003'), 'future assignment unchanged';
end $$;
select expect_failure($q$select public.assign_employee_shift('40000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000001', '2026-10-01')$q$, 'cannot assign');
select expect_failure($q$select public.assign_employee_shift('40000000-0000-0000-0000-000000000003', '50000000-0000-0000-0000-000000000003', '2026-10-01')$q$, 'company');
set request.jwt.claim.sub = '';
select expect_failure($q$select public.assign_employee_shift('40000000-0000-0000-0000-000000000003', '50000000-0000-0000-0000-000000000001', '2026-10-01')$q$, 'Sign in');
reset role;
select 'PASS: atomic shift rollback, future assignments, assignment-only role, company/branch scope, real RLS and goal definition protection' as result;
