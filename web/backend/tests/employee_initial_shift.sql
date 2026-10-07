\set ON_ERROR_STOP on
do $$ begin if current_database()<>'hr_message_requests_audit' then raise exception 'Disposable employee creation database required'; end if; end $$;
begin;
reset role;
set local request.jwt.claim.sub='';
create schema initial_shift;
create function initial_shift.id(k int,n int) returns uuid language sql immutable as $$ select ('d65'||lpad(k::text,5,'0')||'-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid $$;
create table initial_shift.results(label text primary key);
create table initial_shift.saved(label text primary key,value jsonb);
create function initial_shift.expect(label text,ok boolean) returns void language plpgsql as $$ begin if ok is distinct from true then raise exception 'Failed: %',label; end if; insert into initial_shift.results values(label); end $$;
create function initial_shift.error(statement text) returns text language plpgsql as $$ begin execute statement; return 'accepted'; exception when others then return sqlstate; end $$;
grant usage on schema initial_shift to authenticated,anon,service_role;
grant execute on all functions in schema initial_shift to authenticated,anon,service_role;
grant select,insert,update on all tables in schema initial_shift to authenticated,anon,service_role;
insert into public.entities(id,code,name) select initial_shift.id(1,n),'INITIAL-E'||n,'Initial shift company '||n from generate_series(1,2)n;
insert into public.zones(id,entity_id,name) values(initial_shift.id(2,1),initial_shift.id(1,1),'Initial zone');
insert into public.branches(id,entity_id,zone_id,code,name) values
 (initial_shift.id(3,1),initial_shift.id(1,1),initial_shift.id(2,1),'INITIAL-B1','Initial branch'),
 (initial_shift.id(3,2),initial_shift.id(1,1),initial_shift.id(2,1),'INITIAL-B2','Other branch'),
 (initial_shift.id(3,3),initial_shift.id(1,2),null,'INITIAL-B3','Other company branch');
insert into public.departments(id,entity_id,branch_id,name) values
 (initial_shift.id(4,1),initial_shift.id(1,1),initial_shift.id(3,1),'Initial department'),
 (initial_shift.id(4,2),initial_shift.id(1,2),initial_shift.id(3,3),'Other department');
insert into public.shifts(id,entity_id,code,name,start_time,end_time,full_day_minutes,half_day_minutes,break_minutes,break_policy) values
 (initial_shift.id(5,1),initial_shift.id(1,1),'INITIAL-DAY','Selected day','09:30','18:00',510,255,0,'actual'),
 (initial_shift.id(5,2),initial_shift.id(1,2),'INITIAL-OTHER','Other company','09:00','17:30',510,255,0,'actual'),
 (initial_shift.id(5,3),null,'INITIAL-SHARED','Shared night','22:00','06:00',480,240,0,'actual');
insert into public.shifts(id,entity_id,code,name,start_time,end_time,is_active) values
 (initial_shift.id(5,4),initial_shift.id(1,1),'INITIAL-INACTIVE','Inactive','09:00','17:30',false);
insert into auth.users(id,email) select initial_shift.id(6,n),'initial-creator-'||n||'@audit.invalid' from generate_series(1,4)n;
insert into public.roles(id,key,name,rank,is_system) values(initial_shift.id(7,1),'initial_create_only','Creation only',10,false);
insert into public.role_permissions(role_id,permission_id) select initial_shift.id(7,1),id from public.permissions where key='employee.create';
insert into public.role_assignments(user_id,role_id,scope_type,scope_id) values
 (initial_shift.id(6,1),(select id from public.roles where key='branch_manager'),'branch',initial_shift.id(3,1)),
 (initial_shift.id(6,2),(select id from public.roles where key='hr_manager'),'entity',initial_shift.id(1,1)),
 (initial_shift.id(6,3),initial_shift.id(7,1),'department',initial_shift.id(4,1));
set local role authenticated;
select set_config('request.jwt.claim.sub',initial_shift.id(6,1)::text,true);
select initial_shift.expect('scope/company and shared shifts readable',(select count(*)=2 from public.shifts where id in(initial_shift.id(5,1),initial_shift.id(5,2),initial_shift.id(5,3))));
select initial_shift.expect('scope/branch creator has no shift management',not app.has_perm('shift.manage',initial_shift.id(1,1),initial_shift.id(2,1),initial_shift.id(3,1),null,null));
insert into initial_shift.saved values('branch',public.create_employee_with_shift(jsonb_build_object('full_name','  New branch employee  ','employee_code','INITIAL-MANUAL','entity_id',initial_shift.id(1,1),'branch_id',initial_shift.id(3,1),'join_date','2026-10-01'),initial_shift.id(5,1)));
select initial_shift.expect('manual/atomic employee created and normalized',(select value->>'full_name'='New branch employee' and value->>'initial_shift_id'=initial_shift.id(5,1)::text from initial_shift.saved where label='branch'));
select initial_shift.expect('manual/missing shift rejected',initial_shift.error($q$select public.create_employee_with_shift(jsonb_build_object('full_name','Missing shift','entity_id',initial_shift.id(1,1),'branch_id',initial_shift.id(3,1),'join_date','2026-10-01'),null)$q$)='23514');
select initial_shift.expect('manual/missing joining date rejected',initial_shift.error($q$select public.create_employee_with_shift(jsonb_build_object('full_name','Missing date','entity_id',initial_shift.id(1,1),'branch_id',initial_shift.id(3,1)),initial_shift.id(5,1))$q$)='23514');
select initial_shift.expect('manual/inactive shift rejected',initial_shift.error($q$select public.create_employee_with_shift(jsonb_build_object('full_name','Inactive shift','entity_id',initial_shift.id(1,1),'branch_id',initial_shift.id(3,1),'join_date','2026-10-01'),initial_shift.id(5,4))$q$)='23514');
select initial_shift.expect('manual/foreign company shift rejected',initial_shift.error($q$select public.create_employee_with_shift(jsonb_build_object('full_name','Foreign shift','entity_id',initial_shift.id(1,1),'branch_id',initial_shift.id(3,1),'join_date','2026-10-01'),initial_shift.id(5,2))$q$)='23514');
select initial_shift.expect('scope/outside branch rejected by employee RLS',initial_shift.error($q$select public.create_employee_with_shift(jsonb_build_object('full_name','Other branch','entity_id',initial_shift.id(1,1),'branch_id',initial_shift.id(3,2),'join_date','2026-10-01'),initial_shift.id(5,1))$q$)='42501');
select initial_shift.expect('scope/forged zone payload rejected',initial_shift.error($q$select public.create_employee_with_shift(jsonb_build_object('full_name','Forged zone','entity_id',initial_shift.id(1,1),'zone_id',initial_shift.id(2,1),'join_date','2026-10-01'),initial_shift.id(5,1))$q$)='22023');
select initial_shift.expect('scope/forged login rejected',initial_shift.error($q$select public.create_employee_with_shift(jsonb_build_object('full_name','Forged login','entity_id',initial_shift.id(1,1),'user_id',initial_shift.id(6,2),'join_date','2026-10-01'),initial_shift.id(5,1))$q$)='22023');
select initial_shift.expect('scope/forged employee id rejected',initial_shift.error($q$select public.create_employee_with_shift(jsonb_build_object('full_name','Forged id','entity_id',initial_shift.id(1,1),'id',initial_shift.id(8,99),'join_date','2026-10-01'),initial_shift.id(5,1))$q$)='22023');
select initial_shift.expect('manual/direct insert cannot omit initial shift',initial_shift.error($q$insert into public.employees(entity_id,branch_id,full_name,join_date) values(initial_shift.id(1,1),initial_shift.id(3,1),'Direct missing shift','2026-10-01')$q$)='23514');
insert into public.employees(entity_id,branch_id,full_name,employee_code,join_date,initial_shift_id)
 values(initial_shift.id(1,1),initial_shift.id(3,1),'Direct selected shift','INITIAL-DIRECT','2026-10-01',initial_shift.id(5,3));
select initial_shift.expect('manual/direct valid insert retains selected shared shift',(select initial_shift_id=initial_shift.id(5,3) from public.employees where employee_code='INITIAL-DIRECT'));
select initial_shift.expect('provenance/ordinary update cannot reassign creation shift',initial_shift.error($q$update public.employees set initial_shift_id=initial_shift.id(5,3) where employee_code='INITIAL-MANUAL'$q$)='55000');
select initial_shift.expect('scope/ordinary shift assignment still requires shift.manage',initial_shift.error($q$select public.assign_employee_shift((select (value->>'id')::uuid from initial_shift.saved where label='branch'),initial_shift.id(5,3),'2026-11-01')$q$)='42501');
select set_config('request.jwt.claim.sub',initial_shift.id(6,3)::text,true);
insert into initial_shift.saved values('create_only',public.create_employee_with_shift(jsonb_build_object('full_name','Creation permission only','employee_code','INITIAL-CREATE-ONLY','entity_id',initial_shift.id(1,1),'branch_id',initial_shift.id(3,1),'department_id',initial_shift.id(4,1),'join_date','2026-10-01'),initial_shift.id(5,1)));
select initial_shift.expect('scope/create-only role needs no employee.read',(select value->>'id' is not null from initial_shift.saved where label='create_only') and not exists(select 1 from public.employees where employee_code='INITIAL-CREATE-ONLY'));
select initial_shift.expect('scope/foreign department cannot forge company scope',initial_shift.error($q$select public.create_employee_with_shift(jsonb_build_object('full_name','Foreign department','entity_id',initial_shift.id(1,1),'branch_id',initial_shift.id(3,1),'department_id',initial_shift.id(4,2),'join_date','2026-10-01'),initial_shift.id(5,1))$q$)='23514');
select set_config('request.jwt.claim.sub',initial_shift.id(6,4)::text,true);
select initial_shift.expect('scope/unassigned account rejected',initial_shift.error($q$select public.create_employee_with_shift(jsonb_build_object('full_name','No permissions','entity_id',initial_shift.id(1,1),'join_date','2026-10-01'),initial_shift.id(5,1))$q$)='42501');
reset role;
set local request.jwt.claim.sub='';
select initial_shift.expect('manual/exact join-date assignment committed',(select count(*)=1 and bool_and(shift_id=initial_shift.id(5,1) and effective_from='2026-10-01') from public.employee_shift_assignments where employee_id=(select (value->>'id')::uuid from initial_shift.saved where label='branch')));
select initial_shift.expect('manual/rejected calls leave no orphan employees',not exists(select 1 from public.employees where entity_id=initial_shift.id(1,1) and full_name in('Missing shift','Missing date','Inactive shift','Foreign shift','Other branch','Foreign department','No permissions')));
select initial_shift.expect('manual/shared selection creates its own dated assignment',(select count(*)=1 and bool_and(a.shift_id=initial_shift.id(5,3)) from public.employee_shift_assignments a join public.employees e on e.id=a.employee_id where e.employee_code='INITIAL-DIRECT'));
select initial_shift.expect('security/helpers are not callable by browser',not has_function_privilege('authenticated','app.tg_employee_initial_shift_assign()','execute') and not has_function_privilege('authenticated','app.default_employee_creation_shift(uuid)','execute'));
select initial_shift.expect('security/anonymous RPC closed',not has_function_privilege('anon','public.create_employee_with_shift(jsonb,uuid)','execute'));
-- Force the assignment INSERT itself to fail after the employee row was accepted. The whole
-- public RPC must roll back, not leave a saved Directory record requiring a second action.
create function initial_shift.reject_assignment() returns trigger language plpgsql as $$ begin
 if exists(select 1 from public.employees where id=new.employee_id and employee_code='INITIAL-ROLLBACK') then raise exception 'synthetic assignment failure' using errcode='23514'; end if; return new; end $$;
create trigger initial_test_fail before insert on public.employee_shift_assignments for each row execute function initial_shift.reject_assignment();
set local role authenticated;
select set_config('request.jwt.claim.sub',initial_shift.id(6,1)::text,true);
select initial_shift.expect('atomic/assignment failure fails creation',initial_shift.error($q$select public.create_employee_with_shift(jsonb_build_object('full_name','Rollback employee','employee_code','INITIAL-ROLLBACK','entity_id',initial_shift.id(1,1),'branch_id',initial_shift.id(3,1),'join_date','2026-10-01'),initial_shift.id(5,1))$q$)='23514');
reset role;
set local request.jwt.claim.sub='';
drop trigger initial_test_fail on public.employee_shift_assignments;
select initial_shift.expect('atomic/failed assignment removes employee',not exists(select 1 from public.employees where employee_code='INITIAL-ROLLBACK'));
-- Trusted import routes pin the configured default; they do not choose an arbitrary active shift.
insert into public.employees(entity_id,full_name,employee_code,join_date) values(initial_shift.id(1,1),'Trusted known date','INITIAL-TRUSTED','2026-09-01');
insert into public.employees(entity_id,full_name,employee_code) values(initial_shift.id(1,1),'Trusted unknown date','INITIAL-UNKNOWN');
select initial_shift.expect('trusted/default pinned from known date',(select e.initial_shift_id=app.default_employee_creation_shift(e.entity_id) and a.shift_id=e.initial_shift_id and a.effective_from='2026-09-01' from public.employees e join public.employee_shift_assignments a on a.employee_id=e.id where e.employee_code='INITIAL-TRUSTED'));
select initial_shift.expect('trusted/unknown joining date stays unknown',(select e.join_date is null and a.effective_from=(now() at time zone 'Asia/Kolkata')::date and a.note like '%joining date is unknown%' from public.employees e join public.employee_shift_assignments a on a.employee_id=e.id where e.employee_code='INITIAL-UNKNOWN'));
insert into initial_shift.saved select 'trusted_assignment',to_jsonb(a) from public.employee_shift_assignments a join public.employees e on e.id=a.employee_id where e.employee_code='INITIAL-TRUSTED';
update public.shifts set is_default=false where entity_id=initial_shift.id(1,1);
update public.shifts set is_default=true where id=initial_shift.id(5,1);
insert into public.employees(entity_id,full_name,employee_code,join_date) values(initial_shift.id(1,1),'Trusted updated name','INITIAL-TRUSTED','2026-09-01') on conflict(entity_id,employee_code) do update set full_name=excluded.full_name;
select initial_shift.expect('trusted/upsert does not change assignment',(select to_jsonb(a)=s.value from public.employee_shift_assignments a cross join initial_shift.saved s where s.label='trusted_assignment' and a.id=(s.value->>'id')::uuid));
-- Device enrolments run through the same employee insert boundary; missing defaults remain reviewable.
update public.entities set is_active=false where id<>initial_shift.id(1,1);
set local role service_role;
insert into public.biotime_employees(emp_code,full_name,hire_date,last_synced_at) values('INITIAL-DEVICE','New device employee','2026-09-12',clock_timestamp());
insert into public.biotime_employees(emp_code,full_name,last_synced_at) values('INITIAL-DEVICE-UNKNOWN','Unknown hire device employee',clock_timestamp());
reset role;
select initial_shift.expect('device/creation includes configured dated assignment',(select a.shift_id=initial_shift.id(5,1) and a.effective_from='2026-09-12' from public.biotime_employees b join public.employee_shift_assignments a on a.employee_id=b.employee_id where b.emp_code='INITIAL-DEVICE'));
select initial_shift.expect('device/unknown hire date uses honest creation-date assignment',(select e.join_date is null and a.effective_from=(now() at time zone 'Asia/Kolkata')::date and a.note like '%joining date is unknown%' from public.biotime_employees b join public.employees e on e.id=b.employee_id join public.employee_shift_assignments a on a.employee_id=e.id where b.emp_code='INITIAL-DEVICE-UNKNOWN'));
update public.shifts set is_default=false where entity_id=initial_shift.id(1,1) or entity_id is null;
select initial_shift.expect('trusted/missing configured default rejected',initial_shift.error($q$insert into public.employees(entity_id,full_name,employee_code) values(initial_shift.id(1,1),'No configured default','INITIAL-NO-DEFAULT')$q$)='23514');
set local role service_role;
insert into public.biotime_employees(emp_code,full_name,last_synced_at) values('INITIAL-DEVICE-PENDING','Device waiting for configured shift',clock_timestamp());
reset role;
select initial_shift.expect('device/missing default leaves enrolment for review',(select employee_id is null and link_status='ambiguous' from public.biotime_employees where emp_code='INITIAL-DEVICE-PENDING') and not exists(select 1 from public.employees where employee_code='INITIAL-DEVICE-PENDING'));
update public.shifts set is_default=true where id=initial_shift.id(5,3);
insert into public.employees(entity_id,full_name,employee_code,join_date) values(initial_shift.id(1,1),'Shared default trusted employee','INITIAL-SHARED-DEFAULT','2026-10-01');
select initial_shift.expect('trusted/shared configured default supported',(select initial_shift_id=initial_shift.id(5,3) from public.employees where employee_code='INITIAL-SHARED-DEFAULT'));
insert into public.shifts(id,entity_id,code,name,start_time,end_time,full_day_minutes,half_day_minutes,break_minutes,break_policy)
 values(initial_shift.id(5,5),initial_shift.id(1,1),'INITIAL-EARLY','Early new joiner','05:00','13:00',480,240,0,'actual');
set local role authenticated;
select set_config('request.jwt.claim.sub',initial_shift.id(6,2)::text,true);
insert into initial_shift.saved values('early_joiner',public.create_employee_with_shift(jsonb_build_object('full_name','Early shift new joiner','employee_code','INITIAL-EARLY-JOINER','entity_id',initial_shift.id(1,1),'join_date','2026-10-01'),initial_shift.id(5,5)));
reset role;
set local request.jwt.claim.sub='';
select initial_shift.expect('employment/pre-join company night is not a real prior duty',app.attendance_shift_for_date((select (value->>'id')::uuid from initial_shift.saved where label='early_joiner'),'2026-09-30') is null);
select initial_shift.expect('employment/early new joiner succeeds after imaginary night default',(select window_from='2026-09-30 23:00+05:30' from app.attendance_punch_window((select (value->>'id')::uuid from initial_shift.saved where label='early_joiner'),'2026-10-01')));
set local role authenticated;
select set_config('request.jwt.claim.sub',initial_shift.id(6,2)::text,true);
select public.assign_employee_shift((select (value->>'id')::uuid from initial_shift.saved where label='early_joiner'),initial_shift.id(5,3),'2026-10-02','2026-10-02');
select initial_shift.expect('employment/actual overnight overlap still rejected',initial_shift.error($q$select public.assign_employee_shift((select (value->>'id')::uuid from initial_shift.saved where label='early_joiner'),initial_shift.id(5,5),'2026-10-03')$q$)='23514');
reset role;
set local request.jwt.claim.sub='';
set constraints all immediate;
select 'PASS: '||count(*)||' employee initial-shift assertions: atomic creation, scoped RLS, create-only roles, immutable provenance, trusted imports and device defaults' as result from initial_shift.results;
rollback;
