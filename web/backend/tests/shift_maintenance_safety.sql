\set ON_ERROR_STOP on
do $$ begin if current_database() not in ('hr_message_requests_audit','hr_shift_maintenance_audit') then raise exception 'Disposable shift maintenance database required'; end if; end $$;
begin;
reset role;
set local request.jwt.claim.sub='';
create schema shift_safety;
create function shift_safety.id(k int,n int) returns uuid language sql immutable as $$ select ('d64'||lpad(k::text,5,'0')||'-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid $$;
create table shift_safety.results(label text primary key);
create table shift_safety.state(label text primary key,value jsonb);
create function shift_safety.expect(label text,ok boolean) returns void language plpgsql as $$ begin if ok is distinct from true then raise exception 'Failed: %',label; end if; insert into shift_safety.results values(label); end $$;
create function shift_safety.error(statement text) returns text language plpgsql as $$ begin execute statement; return 'accepted'; exception when others then return sqlstate; end $$;
grant usage on schema shift_safety to authenticated,anon;
grant execute on all functions in schema shift_safety to authenticated,anon;
grant select,insert,update on all tables in schema shift_safety to authenticated,anon;
insert into public.entities(id,code,name) select shift_safety.id(1,n),'SHIFT-E'||n,'Shift safety company '||n from generate_series(1,2)n;
insert into public.branches(id,entity_id,code,name) select shift_safety.id(2,n),shift_safety.id(1,n),'SHIFT-B'||n,'Shift safety branch '||n from generate_series(1,2)n;
insert into auth.users(id,email) select shift_safety.id(3,n),'shift-safety-'||n||'@audit.invalid' from generate_series(1,3)n;
insert into public.employees(id,entity_id,branch_id,user_id,full_name,employee_code,status,join_date)
 select shift_safety.id(4,n),shift_safety.id(1,case when n=3 then 2 else 1 end),shift_safety.id(2,case when n=3 then 2 else 1 end),shift_safety.id(3,n),'Shift person '||n,'SHIFT-'||n,'Active','2020-01-01' from generate_series(1,3)n;
insert into public.role_assignments(user_id,role_id,scope_type,scope_id) values
 (shift_safety.id(3,1),(select id from public.roles where key='hr_manager'),'entity',shift_safety.id(1,1)),
 (shift_safety.id(3,2),(select id from public.roles where key='employee'),'self',null),
 (shift_safety.id(3,3),(select id from public.roles where key='hr_manager'),'entity',shift_safety.id(1,2));
insert into public.shifts(id,entity_id,code,name,start_time,end_time,full_day_minutes,half_day_minutes,break_minutes,break_policy,is_flexible) values
 (shift_safety.id(5,1),shift_safety.id(1,1),'SHIFT-DAY','Day','09:00','17:30',510,255,0,'actual',false),
 (shift_safety.id(5,2),shift_safety.id(1,1),'SHIFT-LATE','Later day','09:30','18:00',510,255,0,'actual',false),
 (shift_safety.id(5,3),shift_safety.id(1,1),'SHIFT-NIGHT','Night','22:00','06:00',480,240,0,'actual',false),
 (shift_safety.id(5,4),shift_safety.id(1,1),'SHIFT-EARLY','Early conflicting shift','05:00','13:00',480,240,0,'actual',false);
set local role authenticated;
select set_config('request.jwt.claim.sub',shift_safety.id(3,1)::text,true);
select shift_safety.expect('bulk/selected employees saved atomically',(public.assign_employee_shifts(array[shift_safety.id(4,2),shift_safety.id(4,1)],shift_safety.id(5,1),'2020-09-01')->>'employee_count')::int=2);
select shift_safety.expect('bulk/duplicate employee rejected',shift_safety.error($q$select public.assign_employee_shifts(array[shift_safety.id(4,1),shift_safety.id(4,1)],shift_safety.id(5,2),'2020-09-10')$q$)='22023');
select shift_safety.expect('bulk/out-of-scope employee rejected',shift_safety.error($q$select public.assign_employee_shifts(array[shift_safety.id(4,1),shift_safety.id(4,3)],shift_safety.id(5,2),'2020-09-10')$q$)='42501');
select shift_safety.expect('bulk/failure leaves prior assignments intact',(select count(*)=2 from public.employee_shift_assignments where employee_id in (shift_safety.id(4,1),shift_safety.id(4,2)) and shift_id=shift_safety.id(5,1) and effective_to is null));
select shift_safety.expect('bulk/empty selection rejected',shift_safety.error($q$select public.assign_employee_shifts('{}',shift_safety.id(5,1),'2020-09-01')$q$)='22023');
select shift_safety.expect('bulk/anonymous access closed',not has_function_privilege('anon','public.assign_employee_shifts(uuid[],uuid,date,date,text)','execute'));
reset role;
set local request.jwt.claim.sub='';
insert into public.attendance(employee_id,work_date,shift_id,status,day_type,day_fraction,worked_minutes,check_in,check_out,computed_at) values
 (shift_safety.id(4,1),'2020-09-02',shift_safety.id(5,1),'Present','working',1,510,'2020-09-02 09:00+05:30','2020-09-02 17:30+05:30',now()),
 (shift_safety.id(4,1),'2020-09-03',shift_safety.id(5,1),'Present','working',1,510,'2020-09-03 09:00+05:30','2020-09-03 17:30+05:30',now());
insert into public.payroll_runs(entity_id,period,needs_recalculation) values(shift_safety.id(1,1),'2020-09',false);
update public.attendance_recompute_queue set processed_at=clock_timestamp() where employee_id in (shift_safety.id(4,1),shift_safety.id(4,2));
insert into shift_safety.state values('fingerprint',to_jsonb(app.payroll_source_fingerprint(shift_safety.id(1,1),'2020-09')));
update public.shifts set break_minutes=30,break_policy='fixed',full_day_minutes=480 where id=shift_safety.id(5,1);
select shift_safety.expect('definition/edit queues affected historical attendance',exists(select 1 from public.attendance_recompute_queue where employee_id=shift_safety.id(4,1) and work_date='2020-09-02' and processed_at is null));
select shift_safety.expect('definition/edit invalidates payroll draft',(select needs_recalculation from public.payroll_runs where entity_id=shift_safety.id(1,1) and period='2020-09'));
select shift_safety.expect('definition/source fingerprint changes',(select value<>to_jsonb(app.payroll_source_fingerprint(shift_safety.id(1,1),'2020-09')) from shift_safety.state where label='fingerprint'));
select shift_safety.expect('definition/does not rewrite attendance',(select worked_minutes=510 from public.attendance where employee_id=shift_safety.id(4,1) and work_date='2020-09-02'));
insert into shift_safety.state values('generation',(select to_jsonb(generation) from public.attendance_recompute_queue where employee_id=shift_safety.id(4,1) and work_date='2020-09-02' and processed_at is null));
update public.shifts set break_minutes=20,full_day_minutes=490 where id=shift_safety.id(5,1);
select shift_safety.expect('definition/repeated edit advances queue generation',(select q.generation=(s.value#>>'{}')::bigint+1 from public.attendance_recompute_queue q cross join shift_safety.state s where q.employee_id=shift_safety.id(4,1) and q.work_date='2020-09-02' and q.processed_at is null and s.label='generation'));
update public.attendance set is_locked=true where employee_id=shift_safety.id(4,1) and work_date='2020-09-03';
select shift_safety.expect('published/definition change rejected',shift_safety.error($q$update public.shifts set break_minutes=10 where id=shift_safety.id(5,1)$q$)='55000');
select shift_safety.expect('published/rejected edit leaves rule intact',(select break_minutes=20 from public.shifts where id=shift_safety.id(5,1)));
set local role authenticated;
select set_config('request.jwt.claim.sub',shift_safety.id(3,1)::text,true);
select shift_safety.expect('published/assignment cannot replace locked dates',shift_safety.error($q$select public.assign_employee_shift(shift_safety.id(4,1),shift_safety.id(5,2),'2020-09-01')$q$)='55000');
select public.assign_employee_shift(shift_safety.id(4,1),shift_safety.id(5,2),'2020-09-04');
select shift_safety.expect('published/new assignment preserves old period',(select shift_id=shift_safety.id(5,1) and effective_to='2020-09-03' from public.employee_shift_assignments where employee_id=shift_safety.id(4,1) and effective_from='2020-09-01'));
select public.assign_employee_shift(shift_safety.id(4,2),shift_safety.id(5,3),'2020-09-10','2020-09-10');
select public.assign_employee_shift(shift_safety.id(4,2),shift_safety.id(5,2),'2020-09-11');
reset role;
set local request.jwt.claim.sub='';
select shift_safety.expect('ownership/night-day shares midpoint boundary',(select window_to='2020-09-11 07:45+05:30' from app.attendance_punch_window(shift_safety.id(4,2),'2020-09-10')) and (select window_from='2020-09-11 07:45+05:30' from app.attendance_punch_window(shift_safety.id(4,2),'2020-09-11')));
select shift_safety.expect('ownership/night checkout only belongs to starting date',(select '2020-09-11 06:00+05:30'::timestamptz>=window_from and '2020-09-11 06:00+05:30'::timestamptz<window_to from app.attendance_punch_window(shift_safety.id(4,2),'2020-09-10')) and (select '2020-09-11 06:00+05:30'::timestamptz<window_from from app.attendance_punch_window(shift_safety.id(4,2),'2020-09-11')));
set local role authenticated;
select set_config('request.jwt.claim.sub',shift_safety.id(3,1)::text,true);
select shift_safety.expect('ownership/overlapping next duty rejected atomically',shift_safety.error($q$select public.assign_employee_shift(shift_safety.id(4,2),shift_safety.id(5,4),'2020-09-11')$q$)='23514');
select shift_safety.expect('ownership/failed replacement leaves assignment intact',(select shift_id=shift_safety.id(5,2) from public.employee_shift_assignments where employee_id=shift_safety.id(4,2) and effective_from='2020-09-11'));
select shift_safety.expect('bulk/second employee schedule failure rolls back first employee',shift_safety.error($q$select public.assign_employee_shifts(array[shift_safety.id(4,1),shift_safety.id(4,2)],shift_safety.id(5,4),'2020-09-11')$q$)='23514');
select shift_safety.expect('bulk/first employee unchanged after later failure',(select count(*)=1 and bool_and(effective_from='2020-09-04' and shift_id=shift_safety.id(5,2)) from public.employee_shift_assignments where employee_id=shift_safety.id(4,1) and effective_to is null));
select shift_safety.expect('correction/context contains ownership',public.get_attendance_punch_correction_context(shift_safety.id(4,2),'2020-09-10')#>>'{shift_window,window_to}' is not null);
select public.save_attendance_punch_correction(shift_safety.id(6,1),shift_safety.id(4,2),'2020-09-10','2020-09-11 00:30+05:30','2020-09-11 06:00+05:30','HR verified late night arrival',public.get_attendance_punch_correction_context(shift_safety.id(4,2),'2020-09-10')->>'source_revision');
select shift_safety.expect('correction/next-day arrival belongs to night work date',(select check_in='2020-09-11 00:30+05:30' from public.attendance_regularizations where id=shift_safety.id(6,1)));
select shift_safety.expect('correction/following shift times rejected',shift_safety.error($q$select public.save_attendance_punch_correction(shift_safety.id(6,2),shift_safety.id(4,2),'2020-09-10','2020-09-11 09:30+05:30','2020-09-11 18:00+05:30','Wrong work date',public.get_attendance_punch_correction_context(shift_safety.id(4,2),'2020-09-10')->>'source_revision')$q$)='22023');
select shift_safety.expect('correction/24-hour interval rejected',shift_safety.error($q$select public.save_attendance_punch_correction(shift_safety.id(6,2),shift_safety.id(4,2),'2020-09-10','2020-09-10 00:00+05:30','2020-09-11 00:00+05:30','Invalid long correction',public.get_attendance_punch_correction_context(shift_safety.id(4,2),'2020-09-10')->>'source_revision')$q$)='22023');
insert into shift_safety.state values('correction_revision',public.get_attendance_punch_correction_context(shift_safety.id(4,2),'2020-09-10')->'source_revision');
update public.shifts set grace_in_minutes=12 where id=shift_safety.id(5,3);
select shift_safety.expect('correction/shift change invalidates reviewed context',shift_safety.error($q$select public.save_attendance_punch_correction(shift_safety.id(6,2),shift_safety.id(4,2),'2020-09-10','2020-09-10 22:00+05:30','2020-09-11 06:00+05:30','Stale shift reference',(select value#>>'{}' from shift_safety.state where label='correction_revision'))$q$)='40001');
reset role;
set local request.jwt.claim.sub='';
select shift_safety.expect('breaks/overnight unpaid minutes',app.shift_unpaid_break_minutes('22:00','06:00','[{"label":"Tea","start_time":"23:45","end_time":"00:00","is_paid":true},{"label":"Meal","start_time":"02:00","end_time":"02:30","is_paid":false}]')=30);
update public.shifts set break_policy='scheduled',full_day_minutes=450,break_windows='[{"label":"Meal","start_time":"02:00","end_time":"02:30","is_paid":false}]' where id=shift_safety.id(5,3);
select shift_safety.expect('breaks/scheduled rule saved',(select break_policy='scheduled' and jsonb_array_length(break_windows)=1 from public.shifts where id=shift_safety.id(5,3)));
select shift_safety.expect('breaks/empty scheduled windows rejected',shift_safety.error($q$update public.shifts set break_windows='[]' where id=shift_safety.id(5,3)$q$)='23514');
select shift_safety.expect('breaks/overlap rejected',shift_safety.error($q$update public.shifts set break_windows='[{"label":"Meal","start_time":"02:00","end_time":"02:30","is_paid":false},{"label":"Tea","start_time":"02:15","end_time":"02:45","is_paid":true}]' where id=shift_safety.id(5,3)$q$)='23514');
select shift_safety.expect('breaks/outside shift rejected',shift_safety.error($q$update public.shifts set break_windows='[{"label":"Meal","start_time":"07:00","end_time":"07:30","is_paid":false}]' where id=shift_safety.id(5,3)$q$)='23514');
select shift_safety.expect('breaks/full-day hours remain reachable',shift_safety.error($q$update public.shifts set full_day_minutes=480 where id=shift_safety.id(5,3)$q$)='23514');
select shift_safety.expect('breaks/touching permitted',app.shift_unpaid_break_minutes('09:00','17:30','[{"label":"Meal","start_time":"13:00","end_time":"13:30","is_paid":false},{"label":"Tea","start_time":"13:30","end_time":"13:45","is_paid":true}]')=30);
select shift_safety.expect('breaks/inactive stored windows validated',shift_safety.error($q$update public.shifts set break_policy='actual',break_windows='[{"label":"Outside","start_time":"12:00","end_time":"13:00","is_paid":true}]' where id=shift_safety.id(5,3)$q$)='23514');
select shift_safety.expect('breaks/nonarray rejected with validation error',shift_safety.error($q$select app.shift_unpaid_break_minutes('09:00','17:30','{}')$q$)='23514');
select shift_safety.expect('breaks/nonobject rejected with validation error',shift_safety.error($q$select app.shift_unpaid_break_minutes('09:00','17:30','[null]')$q$)='23514');
select shift_safety.expect('duration/24h shift rejected',shift_safety.error($q$insert into public.shifts(entity_id,code,name,start_time,end_time,full_day_minutes,half_day_minutes) values(shift_safety.id(1,1),'24H','Invalid 24h','09:00','09:00',480,240)$q$)='23514');
insert into public.raw_punches(emp_code,employee_id,punch_time,punch_state,raw) values('SHIFT-2',shift_safety.id(4,2),'2020-10-02 00:30+05:30','255','{}');
select shift_safety.expect('raw/queues four candidate work dates',(select count(distinct work_date)=4 from public.attendance_recompute_queue where employee_id=shift_safety.id(4,2) and work_date between '2020-09-30' and '2020-10-03' and processed_at is null));
insert into public.payslips(employee_id,period,status,gross,deductions,net,payroll_register)
 values(shift_safety.id(4,2),'2020-11','Published',0,0,0,'{"employment_from":"2020-11-01","employment_to":"2020-11-30","attendance_source":"reviewed"}');
select shift_safety.expect('published/reviewed payroll protects definition without attendance',shift_safety.error($q$update public.shifts set grace_in_minutes=15 where id=shift_safety.id(5,2)$q$)='55000');
insert into shift_safety.state select 'published_default',to_jsonb(id) from public.shifts where entity_id=shift_safety.id(1,2) and is_default and is_active;
insert into public.payslips(employee_id,period,status,gross,deductions,net,payroll_register)
 select shift_safety.id(4,3),'2020-11','Published',0,0,0,jsonb_build_object('employment_from','2020-11-01','employment_to','2020-11-30','attendance_source','reviewed',
 'shift_days',jsonb_build_array(jsonb_build_object('work_date','2020-11-01','shift_id',value#>>'{}'))) from shift_safety.state where label='published_default';
update public.shifts set is_active=false where id=(select (value#>>'{}')::uuid from shift_safety.state where label='published_default');
select shift_safety.expect('published/deactivated default still protected by saved shift snapshot',shift_safety.error($q$update public.shifts set grace_in_minutes=16 where id=(select (value#>>'{}')::uuid from shift_safety.state where label='published_default')$q$)='55000');
set local role authenticated;
select set_config('request.jwt.claim.sub',shift_safety.id(3,1)::text,true);
select shift_safety.expect('published/reviewed payroll protects assignment without attendance',shift_safety.error($q$select public.assign_employee_shift(shift_safety.id(4,2),shift_safety.id(5,4),'2020-11-01')$q$)='55000');
reset role;
set local request.jwt.claim.sub='';
set constraints shift_assignment_validate immediate;
select 'PASS: '||count(*)||' shift maintenance assertions: bulk atomicity, upstream freshness, published guards, rotation ownership, overnight corrections and scheduled breaks' as result from shift_safety.results;
rollback;
