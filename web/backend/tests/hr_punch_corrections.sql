\set ON_ERROR_STOP on
do $$ begin
  if current_database() not in ('hr_message_requests_audit','hr_punch_corrections_audit') then
    raise exception 'Disposable punch-correction database required';
  end if;
end $$;
begin;
reset role;
set local request.jwt.claim.sub='';
create schema punch_test;
create function punch_test.id(k integer,n integer) returns uuid language sql immutable as $$
  select ('d62'||lpad(k::text,5,'0')||'-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid
$$;
create table punch_test.results(label text primary key);
create table punch_test.state(label text primary key,value jsonb);
create function punch_test.expect(label text,actual boolean) returns void language plpgsql as $$
begin
  if actual is distinct from true then raise exception 'Failed: %',label; end if;
  insert into punch_test.results values(label);
end $$;
create function punch_test.error(statement text) returns text language plpgsql as $$
begin execute statement; return 'accepted'; exception when others then return sqlstate; end $$;
create function punch_test.context(_date date default '2020-09-01',_employee integer default 1)
returns jsonb language sql as $$ select public.get_attendance_punch_correction_context(punch_test.id(4,_employee),_date) $$;
create function punch_test.save(_request integer,_date date default '2020-09-01',_employee integer default 1,
  _in timestamptz default null,_out timestamptz default '2020-09-01 18:00+05:30',_reason text default 'Verified missed punch',_revision text default null)
returns jsonb language sql as $$
  select public.save_attendance_punch_correction(punch_test.id(6,_request),punch_test.id(4,_employee),_date,_in,_out,_reason,
    coalesce(_revision,punch_test.context(_date,_employee)->>'source_revision'))
$$;
grant usage on schema punch_test to authenticated,anon;
grant execute on all functions in schema punch_test to authenticated,anon;
grant select,insert,update on all tables in schema punch_test to authenticated,anon;
insert into public.entities(id,code,name) select punch_test.id(1,n),'PUNCH-E'||n,'Punch company '||n from generate_series(1,2)n;
insert into public.branches(id,entity_id,code,name)
  select punch_test.id(2,n),punch_test.id(1,case when n=3 then 2 else 1 end),'PUNCH-B'||n,'Punch branch '||n from generate_series(1,3)n;
insert into auth.users(id,email) select punch_test.id(3,n),'punch-'||n||'@audit.invalid' from generate_series(1,5)n;
insert into public.employees(id,entity_id,branch_id,user_id,employee_code,full_name,status,join_date)
  select punch_test.id(4,n),punch_test.id(1,case when n=3 then 2 else 1 end),
    punch_test.id(2,case when n=3 then 3 when n=4 then 2 else 1 end),punch_test.id(3,n),
    'PUNCH-'||n,'Punch actor '||n,'Active','2019-01-01' from generate_series(1,5)n;
update public.profiles p set employee_id=e.id from public.employees e where p.user_id=e.user_id and e.employee_code like 'PUNCH-%';
insert into public.role_assignments(user_id,role_id,scope_type)
  select punch_test.id(3,n),r.id,'self' from generate_series(1,5)n cross join public.roles r where r.key='employee';
insert into public.role_assignments(user_id,role_id,scope_type,scope_id) values
  (punch_test.id(3,2),(select id from public.roles where key='hr_manager'),'branch',punch_test.id(2,1)),
  (punch_test.id(3,3),(select id from public.roles where key='hr_manager'),'entity',punch_test.id(1,2));
insert into public.roles(id,key,name) values(punch_test.id(7,1),'punch_reader','Punch read-only test');
insert into public.role_permissions(role_id,permission_id) select punch_test.id(7,1),id from public.permissions where key='attendance.read';
insert into public.role_assignments(user_id,role_id,scope_type,scope_id) values(punch_test.id(3,5),punch_test.id(7,1),'branch',punch_test.id(2,1));
-- Overnight correction validity uses the employee's dated night assignment.
insert into public.shifts(id,entity_id,code,name,start_time,end_time,full_day_minutes,half_day_minutes,break_minutes,break_policy)
  values(punch_test.id(8,1),punch_test.id(1,1),'PUNCH-NIGHT','Correction night fixture','22:00','06:00',480,240,0,'actual');
insert into public.employee_shift_assignments(employee_id,shift_id,effective_from,effective_to)
  values(punch_test.id(4,1),punch_test.id(8,1),'2020-09-02','2020-09-02');
insert into public.raw_punches(emp_code,employee_id,punch_time,punch_state,raw)
  values('PUNCH-1',punch_test.id(4,1),'2020-09-01 09:00+05:30','0','{"device_evidence":"unchanged"}');
insert into public.attendance(employee_id,work_date,status,check_in,worked_minutes,is_missing_punch,computed_at)
  values(punch_test.id(4,1),'2020-09-01','Missing Punch','2020-09-01 09:00+05:30',0,true,now());
insert into public.payroll_runs(entity_id,period,needs_recalculation) values(punch_test.id(1,1),'2020-09',false);
insert into punch_test.state values
  ('raw',(select jsonb_agg(to_jsonb(p)) from public.raw_punches p where employee_id=punch_test.id(4,1))),
  ('attendance',(select to_jsonb(a) from public.attendance a where employee_id=punch_test.id(4,1) and work_date='2020-09-01'));

set local role authenticated;
select set_config('request.jwt.claim.sub',punch_test.id(3,2)::text,true);
insert into punch_test.state values('context',punch_test.context());
select punch_test.expect('read/context includes raw and derived day with writable revision',
  (select (value->>'can_correct')::boolean and length(value->>'source_revision')=32 and jsonb_array_length(value->'raw_punches')=1
    and value#>>'{attendance,status}'='Missing Punch' from punch_test.state where label='context'));
select punch_test.expect('save/missing checkout uses one approved Supabase overlay',not (punch_test.save(1)->>'already_saved')::boolean);
select punch_test.expect('save/server owns actor and source metadata',
  (select status='Approved' and check_in is null and check_out='2020-09-01 18:00+05:30' and requested_by=punch_test.id(3,2)
    and decided_by=punch_test.id(3,2) and approver_id=punch_test.id(4,2) and decided_at is not null
    from public.attendance_regularizations where id=punch_test.id(6,1)));
select punch_test.expect('retry/exact committed retry returns original receipt despite source changes',
  (punch_test.save(1,_revision=>(select value->>'source_revision' from punch_test.state where label='context'))->>'already_saved')::boolean);
select punch_test.expect('retry/changed payload rejected',punch_test.error($q$select punch_test.save(1,_reason=>'Changed reason')$q$)='40001');
select punch_test.expect('save/direct history insert denied',punch_test.error($q$insert into public.attendance_punch_correction_history select * from public.attendance_punch_correction_history$q$)='42501');
select punch_test.expect('save/history update denied',punch_test.error($q$update public.attendance_punch_correction_history set reason='tampered'$q$)='42501');
select punch_test.expect('save/direct approved write remains denied',punch_test.error($q$insert into public.attendance_regularizations(employee_id,work_date,check_in,reason,status)
  values(punch_test.id(4,1),'2020-09-02','2020-09-02 09:00+05:30','Not an HR RPC','Approved')$q$)='42501');
select punch_test.expect('save/stale revision cannot overwrite earlier correction',punch_test.error($q$select punch_test.save(2,_revision=>(select value->>'source_revision' from punch_test.state where label='context'))$q$)='40001');
select punch_test.save(2,_in=>'2020-09-01 08:45+05:30',_reason=>'Corrected arrival after HR review');
select punch_test.expect('replace/one active overlay and original reason preserved',
  (select count(*)=1 from public.attendance_regularizations where employee_id=punch_test.id(4,1) and work_date='2020-09-01' and status='Approved')
  and (select status='Cancelled' and reason='Verified missed punch' and check_in is null and decided_by=punch_test.id(3,2)
    from public.attendance_regularizations where id=punch_test.id(6,1)));
select punch_test.expect('replace/history links immutable before and after evidence',
  (select previous_correction_id=punch_test.id(6,1) and before_state#>>'{active_correction,status}'='Approved'
    and after_state->>'status'='Approved' and changed_by=punch_test.id(3,2)
    from public.attendance_punch_correction_history where request_id=punch_test.id(6,2)));
select punch_test.expect('read/context returns correction and audit history',jsonb_array_length(punch_test.context()->'history')=2
  and jsonb_array_length(punch_test.context()->'correction_history')=2);
select punch_test.expect('read/day without derived attendance remains editable',(punch_test.context('2020-09-02')->>'can_correct')::boolean
  and punch_test.context('2020-09-02')->'attendance'='null'::jsonb);
select punch_test.save(3,'2020-09-02',_in=>'2020-09-02 22:00+05:30',_out=>'2020-09-03 06:00+05:30',_reason=>'Verified overnight shift');
select punch_test.expect('save/overnight endpoints preserved',(select check_out-check_in=interval '8 hours'
  from public.attendance_regularizations where id=punch_test.id(6,3)));
select punch_test.save(4,'2020-09-04',_in=>'2020-09-04 09:00+05:30',_out=>null,_reason=>'Verified missing arrival');
select punch_test.expect('save/check-in-only correction supported',(select check_out is null and check_in is not null
  from public.attendance_regularizations where id=punch_test.id(6,4)));
select punch_test.expect('validation/empty endpoints rejected',punch_test.error($q$select punch_test.save(90,_in=>null,_out=>null)$q$)='22023');
select punch_test.expect('validation/reason required',punch_test.error($q$select punch_test.save(90,_reason=>'  ')$q$)='22023');
select punch_test.expect('validation/long reason rejected',punch_test.error($q$select punch_test.save(90,_reason=>repeat('x',1001))$q$)='22023');
select punch_test.expect('validation/reversed interval rejected',punch_test.error($q$select punch_test.save(90,_in=>'2020-09-01 19:00+05:30')$q$)='22023');
select punch_test.expect('validation/check-in cannot belong to another date',punch_test.error($q$select punch_test.save(90,_in=>'2020-08-31 23:00+05:30')$q$)='22023');
select punch_test.expect('validation/checkout beyond next day rejected',punch_test.error($q$select punch_test.save(90,_out=>'2020-09-03 01:00+05:30')$q$)='22023');
select punch_test.expect('validation/future punches rejected',punch_test.error($q$select punch_test.save(90,'2099-01-01',_in=>'2099-01-01 09:00+05:30',_out=>null)$q$)='22023');
select punch_test.expect('validation/pre-employment date rejected',punch_test.error($q$select punch_test.save(90,'2018-01-01',_in=>'2018-01-01 09:00+05:30',_out=>null)$q$)='22023');
select punch_test.expect('scope/own correction denied',punch_test.error($q$select punch_test.save(90,_employee=>2)$q$)='42501');
select punch_test.expect('scope/other branch correction denied',punch_test.error($q$select punch_test.save(90,_employee=>4)$q$)='42501');
select punch_test.expect('scope/other company read denied',punch_test.error($q$select punch_test.context(_employee=>3)$q$)='42501');
select set_config('request.jwt.claim.sub',punch_test.id(3,1)::text,true);
select punch_test.expect('scope/employee cannot correct self',punch_test.error($q$select punch_test.save(90)$q$)='42501');
insert into public.attendance_regularizations(employee_id,work_date,check_in,reason)
  values(punch_test.id(4,1),'2020-09-05','2020-09-05 09:00+05:30','Requested by employee');
select set_config('request.jwt.claim.sub',punch_test.id(3,5)::text,true);
select punch_test.expect('scope/reader context has no edit permission',not (punch_test.context()->>'can_correct')::boolean);
select punch_test.expect('scope/reader save denied',punch_test.error($q$select punch_test.save(90)$q$)='42501');
select set_config('request.jwt.claim.sub',punch_test.id(3,2)::text,true);
select punch_test.expect('pending/request cannot be bypassed',punch_test.error($q$select punch_test.save(90,'2020-09-05',_out=>'2020-09-05 18:00+05:30')$q$)='55000');
select punch_test.expect('pending/context explains request lock',not (punch_test.context('2020-09-05')->>'can_correct')::boolean
  and punch_test.context('2020-09-05')#>>'{active_correction,status}'='Pending');
insert into punch_test.state values('stale',punch_test.context('2020-09-06'));
reset role;
set local request.jwt.claim.sub='';
select punch_test.expect('evidence/raw device rows unchanged',(select jsonb_agg(to_jsonb(p)) from public.raw_punches p where employee_id=punch_test.id(4,1))
  =(select value from punch_test.state where label='raw'));
select punch_test.expect('evidence/derived row not directly overwritten',(select to_jsonb(a) from public.attendance a where employee_id=punch_test.id(4,1) and work_date='2020-09-01')
  =(select value from punch_test.state where label='attendance'));
select punch_test.expect('engine/recompute queued',(select count(*)=4 from public.attendance_recompute_queue
  where employee_id=punch_test.id(4,1) and work_date in ('2020-09-01','2020-09-02','2020-09-04','2020-09-05') and processed_at is null));
select punch_test.expect('payroll/draft requires recalculation',(select needs_recalculation from public.payroll_runs where entity_id=punch_test.id(1,1) and period='2020-09'));
select punch_test.expect('audit/one server actor event for each committed correction',(select count(*)=4 from public.audit_log
  where action='ATTENDANCE_PUNCH_CORRECTED' and actor=punch_test.id(3,2) and entity_id=punch_test.id(1,1)));
select punch_test.expect('audit/even owner cannot edit immutable history',punch_test.error($q$update public.attendance_punch_correction_history set reason='tampered'$q$)='55000');
select punch_test.expect('notifications/direct correction sends no request or decision notification',
  not exists(select 1 from public.notifications where ref_id in (punch_test.id(6,1),punch_test.id(6,2),punch_test.id(6,3),punch_test.id(6,4))));
insert into public.raw_punches(emp_code,employee_id,punch_time) values('PUNCH-1',punch_test.id(4,1),'2020-09-06 09:00+05:30');
insert into public.attendance(employee_id,work_date,status,is_locked) values(punch_test.id(4,1),'2020-09-07','Absent',true);
insert into public.payslips(employee_id,period,status,gross,deductions,net) values(punch_test.id(4,1),'2020-08','Published',1000,0,1000);
set local role authenticated;
select set_config('request.jwt.claim.sub',punch_test.id(3,2)::text,true);
select punch_test.expect('conflict/new raw punch invalidates editor revision',punch_test.error($q$select punch_test.save(90,'2020-09-06',_out=>'2020-09-06 18:00+05:30',_revision=>(select value->>'source_revision' from punch_test.state where label='stale'))$q$)='40001');
insert into punch_test.state values('derived-stale',punch_test.context());
select punch_test.expect('lock/locked attendance refuses correction',punch_test.error($q$select punch_test.save(90,'2020-09-07',_out=>'2020-09-07 18:00+05:30')$q$)='55000');
select punch_test.expect('lock/published salary refuses correction even without attendance row',punch_test.error($q$select punch_test.save(90,'2020-08-07',_out=>'2020-08-07 18:00+05:30')$q$)='55000');
select punch_test.expect('lock/published context explains lock',(punch_test.context('2020-08-07')->>'is_locked')::boolean);
reset role;
set local request.jwt.claim.sub='';
update public.attendance set computed_at=clock_timestamp(),worked_minutes=500 where employee_id=punch_test.id(4,1) and work_date='2020-09-01';
set local role authenticated;
select set_config('request.jwt.claim.sub',punch_test.id(3,2)::text,true);
select punch_test.expect('conflict/worker recompute invalidates editor revision',punch_test.error($q$select punch_test.save(90,_revision=>(select value->>'source_revision' from punch_test.state where label='derived-stale'))$q$)='40001');
reset role;
update public.profiles set is_super_admin=true where user_id=punch_test.id(3,2);
set local role authenticated;
select punch_test.expect('scope/super-admin own correction still denied',punch_test.error($q$select punch_test.save(90,_employee=>2)$q$)='42501');
reset role;
update auth.users set banned_until='infinity' where id=punch_test.id(3,2);
set local role authenticated;
select punch_test.expect('revocation/stale token read denied',punch_test.error($q$select punch_test.context()$q$)='42501');
select punch_test.expect('revocation/stale token save denied',punch_test.error($q$select punch_test.save(90)$q$)='42501');
reset role;
set local request.jwt.claim.sub='';
select punch_test.expect('grants/anonymous cannot invoke RPCs',
  not has_function_privilege('anon','public.get_attendance_punch_correction_context(uuid,date)','execute')
  and not has_function_privilege('anon','public.save_attendance_punch_correction(uuid,uuid,date,timestamptz,timestamptz,text,text)','execute'));
select punch_test.expect('grants/internal snapshot cannot bypass scoped RPC',
  not has_function_privilege('authenticated','app.attendance_punch_correction_source(uuid,date)','execute'));
select 'PASS: '||count(*)||' HR punch-correction assertions: scoped direct edits, immutable source/audit, retries, supersession, overnight, stale evidence, pending/finalized locks and account revocation' as result from punch_test.results;
rollback;
