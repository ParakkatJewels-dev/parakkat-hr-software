\set ON_ERROR_STOP on
-- Executed only after production migrations in a disposable local database. Every fixture rolls back.
do $$ begin
  if current_database() <> 'hr_message_requests_audit' then
    raise exception 'Disposable report/input audit database required';
  end if;
end $$;
begin;
reset role;
set local request.jwt.claim.sub = '';
create schema audit_report_input;
create function audit_report_input.id(kind integer, n integer) returns uuid language sql immutable as $$
  select ('d45' || lpad(kind::text,5,'0') || '-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid
$$;
create function audit_report_input.expect_error(statement text, expected_code text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if sqlstate = expected_code then return; end if;
    raise;
  end;
  raise exception 'Expected SQLSTATE % from %', expected_code, statement;
end $$;
grant usage on schema audit_report_input to authenticated, anon;
grant execute on all functions in schema audit_report_input to authenticated, anon;

insert into public.entities(id,code,name)
  select audit_report_input.id(1,n), 'REPORT-E'||n, 'Report test company '||n from generate_series(1,2)n;
insert into public.branches(id,entity_id,code,name)
  select audit_report_input.id(2,n),audit_report_input.id(1,n),'REPORT-B'||n,'Report test branch '||n from generate_series(1,2)n;
insert into auth.users(id,email)
  select audit_report_input.id(3,n),'report-actor-'||n||'@audit.invalid' from generate_series(1,5)n;
insert into public.employees(id,entity_id,branch_id,user_id,employee_code,full_name,status)
  select audit_report_input.id(4,n),audit_report_input.id(1,case when n=3 then 2 else 1 end),
    audit_report_input.id(2,case when n=3 then 2 else 1 end),audit_report_input.id(3,n),
    'REPORT-ACTOR-'||n,'Report actor '||n,case when n=5 then 'Inactive' else 'Active' end
  from generate_series(1,5)n;
update public.profiles p set employee_id=e.id from public.employees e
  where p.user_id=e.user_id and e.employee_code like 'REPORT-ACTOR-%';
insert into public.role_assignments(user_id,role_id,scope_type)
  select audit_report_input.id(3,n),r.id,'self' from generate_series(1,5)n cross join public.roles r where r.key='employee';
insert into public.role_assignments(user_id,role_id,scope_type,scope_id)
  select audit_report_input.id(3,n),r.id,'entity',audit_report_input.id(1,1)
    from generate_series(4,5)n cross join public.roles r where r.key='hr_manager';
insert into public.shifts(id,entity_id,code,name,start_time,end_time,weekly_offs)
  values(audit_report_input.id(5,1),audit_report_input.id(1,1),'REPORT-DAY','Report shift','09:00','18:00',array[0]);
insert into public.employee_shift_assignments(employee_id,shift_id,effective_from)
  select audit_report_input.id(4,n),audit_report_input.id(5,1),'2026-01-01'::date from generate_series(1,2)n;
insert into public.holiday_calendars(id,entity_id,code,name)
  values(audit_report_input.id(6,1),audit_report_input.id(1,1),'REPORT-CALENDAR','Report holiday calendar');
update public.branches set holiday_calendar_id=audit_report_input.id(6,1)
  where id=audit_report_input.id(2,1);
insert into public.holidays(calendar_id,holiday_date,name,is_optional) values
  (audit_report_input.id(6,1),'2026-08-04','Report mandatory holiday',false),
  (audit_report_input.id(6,1),'2026-08-05','Report optional holiday',true);

-- Jul 30/31 = 2 working days; Aug 1/5/6 = 3 after Sunday, holiday and one cancellation.
-- Duplicate/out-of-period/nonworking cancellations must not subtract twice or outside the window.
insert into public.leaves(id,employee_id,type,start_date,end_date,days,day_fraction,cancelled_dates,status) values
  (audit_report_input.id(7,1),audit_report_input.id(4,1),'REPORT-LEAVE','2026-07-30','2026-08-06',8,1,
    array['2026-08-03','2026-08-03','2026-08-02','2026-09-01']::date[],'Approved'),
  (audit_report_input.id(7,2),audit_report_input.id(4,2),'REPORT-LEAVE','2026-07-30','2026-08-06',4,0.5,
    array['2026-08-03']::date[],'Approved'),
  (audit_report_input.id(7,3),audit_report_input.id(4,3),'REPORT-LEAVE','2026-08-07','2026-08-07',1,1,'{}','Pending'),
  (audit_report_input.id(7,4),audit_report_input.id(4,1),'REPORT-LEAVE','2026-08-07','2026-08-07',1,1,
    array['2026-08-07']::date[],'Approved'),
  (audit_report_input.id(7,5),audit_report_input.id(4,1),'REPORT-LEAVE','2026-09-07','2026-09-07',1,1,'{}','Pending');

do $$ begin
  assert not has_function_privilege('anon','public.report_leave_days(date,date)','execute'), 'Anonymous cannot call the report';
  assert has_function_privilege('authenticated','public.report_leave_days(date,date)','execute'), 'Authenticated report is available';
end $$;
set local role anon;
select audit_report_input.expect_error($q$select * from public.report_leave_days('2026-08-01','2026-08-31')$q$,'42501');
set local role authenticated;
select audit_report_input.expect_error($q$select * from public.report_leave_days('2026-08-01','2026-08-31')$q$,'42501');
set local request.jwt.claim.sub='d4500003-0000-0000-0000-000000000004';
do $$ begin
  assert (select period_days=2 from public.report_leave_days('2026-07-01','2026-07-31') where leave_id=audit_report_input.id(7,1)), 'Full leave is allocated to July';
  assert (select period_days=3 from public.report_leave_days('2026-08-01','2026-08-31') where leave_id=audit_report_input.id(7,1)), 'Only effective August leave is counted';
  assert (select period_days=1.5 from public.report_leave_days('2026-08-01','2026-08-31') where leave_id=audit_report_input.id(7,2)), 'Half leave retains fractional period allocation';
  assert (select period_days=5 from public.report_leave_days('2026-07-01','2026-08-31') where leave_id=audit_report_input.id(7,1)), 'Adjacent month allocations reconcile to full effective leave';
  assert (select period_days=0 from public.report_leave_days('2026-08-01','2026-08-31') where leave_id=audit_report_input.id(7,4)), 'Wholly cancelled dates contribute zero';
  assert (select count(*)=3 from public.report_leave_days('2026-08-01','2026-08-31')), 'Manager sees three company records, excluding other entity and out-of-period leave';
  assert not exists(select from public.report_leave_days('2026-08-01','2026-08-31') where leave_id=audit_report_input.id(7,3)), 'Security definer does not bypass entity scope';
  assert not exists(select from public.report_leave_days('2026-08-01','2026-08-31') where leave_id not in(select id from public.leaves)), 'Report IDs match leaves RLS';
end $$;
select audit_report_input.expect_error($q$select * from public.report_leave_days(null,'2026-08-31')$q$,'22023');
select audit_report_input.expect_error($q$select * from public.report_leave_days('2026-09-01','2026-08-31')$q$,'22023');
select audit_report_input.expect_error($q$select * from public.report_leave_days('2025-01-01','2026-08-31')$q$,'22023');
set local request.jwt.claim.sub='d4500003-0000-0000-0000-000000000001';
do $$ begin
  assert (select count(*)=2 from public.report_leave_days('2026-08-01','2026-08-31')), 'Employee sees only their two own period records';
  assert not exists(select from public.report_leave_days('2026-08-01','2026-08-31') where leave_id=audit_report_input.id(7,2)), 'Colleague leave is not exposed';
end $$;
set local request.jwt.claim.sub='d4500003-0000-0000-0000-000000000005';
select audit_report_input.expect_error($q$select * from public.report_leave_days('2026-08-01','2026-08-31')$q$,'42501');

reset role;
set local request.jwt.claim.sub='';
-- The title constraint applies to direct writes as well as browser validation.
do $$ declare title text; begin
  foreach title in array array['','   ',E'\t',E'\n\r',E'\f',chr(11),E' \t\n\r\f' || chr(11)] loop
    perform audit_report_input.expect_error(format('insert into public.jobs(title) values (%L)',title),'23514');
  end loop;
end $$;
insert into public.jobs(id,title) values
  (audit_report_input.id(8,1),E' \tShift Supervisor\n '),
  (audit_report_input.id(8,2),'v');
select audit_report_input.expect_error($q$update public.jobs set title=E'\t \n' where id=audit_report_input.id(8,1)$q$,'23514');
do $$ begin
  assert exists(select from public.jobs where id=audit_report_input.id(8,1) and btrim(title,E' \t\n\r')='Shift Supervisor'), 'Nonblank human title remains valid';
end $$;
rollback;
select 'PASS: report period allocation, half days, calendar/cancelled dates, leave scope, inactive denial and blank job-title rejection' as result;
