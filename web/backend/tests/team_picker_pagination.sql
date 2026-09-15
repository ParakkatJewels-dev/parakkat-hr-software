-- Disposable local contract fixture; never run on an application database.
\set ON_ERROR_STOP on
do $$ begin
  if current_database() <> 'hr_team_picker_audit' then raise exception 'requires disposable hr_team_picker_audit database'; end if;
end $$;
create schema app;
do $$ begin
  if not exists(select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists(select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
end $$;
create table public.departments(id uuid primary key, entity_id uuid, branch_id uuid, name text);
create table public.branches(id uuid primary key, code text);
create table public.employees(id uuid primary key, entity_id uuid, department_id uuid, branch_id uuid,
  full_name text, employee_code text, status text);
-- Minimal permission fixture isolates the existing per-department authorization boundary.
create function app.has_perm(permission text, entity uuid, zone uuid, branch uuid, department uuid, employee uuid)
returns boolean language sql stable as $$
  select permission = 'employee.assign' and department = nullif(current_setting('audit.allowed_department', true), '')::uuid
$$;

\ir ../supabase/migrations/0136_complete_team_employee_picker.sql
-- Safe to reapply, as with the application's migration runner.
\ir ../supabase/migrations/0136_complete_team_employee_picker.sql

insert into public.departments values
  ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', null, 'Target team'),
  ('00000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', null, 'Another team');
insert into public.employees
select md5(n::text)::uuid, '10000000-0000-0000-0000-000000000001', null, null,
  'Candidate ' || lpad((n / 3)::text, 4, '0'), 'EMP' || lpad(n::text, 4, '0'), 'Active'
from generate_series(1, 1205) n;
insert into public.employees values
  (md5('already-assigned')::uuid, '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', null, 'Already assigned', 'EXCLUDE1', 'Active'),
  (md5('inactive')::uuid, '10000000-0000-0000-0000-000000000001', null, null, 'Inactive person', 'EXCLUDE2', 'Inactive'),
  (md5('other-company')::uuid, '10000000-0000-0000-0000-000000000002', null, null, 'Other company', 'EXCLUDE3', 'Active');

set role authenticated;
select set_config('audit.allowed_department', '00000000-0000-0000-0000-000000000001', false);
do $$ declare
  complete uuid[];
  paged uuid[];
begin
  select array_agg(id order by full_name, id) into complete
    from public.assignable_employees('00000000-0000-0000-0000-000000000001');
  if cardinality(complete) <> 1205 then raise exception 'Picker truncated or included out-of-scope rows'; end if;
  select array_agg(id order by full_name, id) into paged from (
    (select * from public.assignable_employees('00000000-0000-0000-0000-000000000001') order by full_name, id limit 500)
    union all
    (select * from public.assignable_employees('00000000-0000-0000-0000-000000000001') order by full_name, id limit 500 offset 500)
    union all
    (select * from public.assignable_employees('00000000-0000-0000-0000-000000000001') order by full_name, id limit 500 offset 1000)
  ) pages;
  if paged is distinct from complete then raise exception 'Page boundaries duplicated or omitted a candidate'; end if;
  if (select count(*) from public.assignable_employees('00000000-0000-0000-0000-000000000001', 'EMP1205')) <> 1 then
    raise exception 'Search omitted candidate beyond old cap';
  end if;
  begin
    perform * from public.assignable_employees('00000000-0000-0000-0000-000000000002');
    raise exception 'Unauthorized department was accepted';
  exception when insufficient_privilege then null; end;
  begin
    perform * from public.assignable_employees('00000000-0000-0000-0000-000000000099');
    raise exception 'Unknown department was accepted';
  exception when undefined_object then null; end;
end $$;
reset role;
do $$ begin
  if has_function_privilege('anon', 'public.assignable_employees(uuid,text)', 'EXECUTE') then
    raise exception 'Anonymous users can list candidates';
  end if;
end $$;

select 'PASS: Team picker returns all 1205 candidates across ordered pages, preserves search and scope restrictions, and denies anonymous access';
